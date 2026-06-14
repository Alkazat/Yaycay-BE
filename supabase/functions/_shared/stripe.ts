// Minimal Stripe helper: create a Checkout Session and verify webhook
// signatures, using the REST API + Web Crypto rather than the SDK (matches the
// repo's fetch-based, dependency-light style and runs cleanly on Deno edge).

import { optionalEnv } from './env.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

export function stripeConfigured(): boolean {
  return !!optionalEnv('STRIPE_SECRET_KEY');
}

/**
 * Whether the configured Stripe key is a live key (vs test). Used to scope the
 * product catalogue to the deployment's mode: prod runs a live key, staging a
 * test key, and the seeded table holds both sets of prices.
 */
export function stripeLivemode(): boolean {
  const key = optionalEnv('STRIPE_SECRET_KEY') ?? '';
  return key.startsWith('sk_live') || key.startsWith('rk_live');
}

export interface CheckoutSessionParams {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** The authenticated user's id (Stripe client_reference_id). */
  clientReferenceId: string;
  customerEmail?: string;
  /** Echoed back on the webhook event, e.g. user_id / trip_id / tier. */
  metadata: Record<string, string>;
  mode?: 'payment' | 'subscription';
  /** A Stripe promotion code id to pre-apply (affiliate discount). */
  promotionCode?: string;
}

/** Create a Stripe Checkout Session; returns its id and hosted URL. */
export async function createCheckoutSession(
  secretKey: string,
  p: CheckoutSessionParams,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams();
  form.append('mode', p.mode ?? 'payment');
  form.append('line_items[0][price]', p.priceId);
  form.append('line_items[0][quantity]', '1');
  form.append('success_url', p.successUrl);
  form.append('cancel_url', p.cancelUrl);
  form.append('client_reference_id', p.clientReferenceId);
  if (p.customerEmail) form.append('customer_email', p.customerEmail);
  // Pre-apply the affiliate promotion code, else let the customer enter one.
  // (Stripe forbids combining `discounts` with `allow_promotion_codes`.)
  if (p.promotionCode) form.append('discounts[0][promotion_code]', p.promotionCode);
  else form.append('allow_promotion_codes', 'true');
  for (const [k, v] of Object.entries(p.metadata)) form.append(`metadata[${k}]`, v);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`Stripe checkout create failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { id: data.id as string, url: data.url as string };
}

// ----- Affiliate coupons + promotion codes ----------------------------------

async function stripeForm(
  secretKey: string,
  path: string,
  form: URLSearchParams,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Stripe ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Create a percent-off coupon; returns its id. */
export async function createCoupon(
  secretKey: string,
  percentOff: number,
  name: string,
): Promise<string> {
  const form = new URLSearchParams();
  form.append('percent_off', String(percentOff));
  form.append('duration', 'forever');
  form.append('name', name);
  const data = await stripeForm(secretKey, '/coupons', form);
  return data.id as string;
}

/** Create a promotion code (the customer-facing code) for a coupon; returns its id. */
export async function createPromotionCode(
  secretKey: string,
  couponId: string,
  code: string,
): Promise<string> {
  const form = new URLSearchParams();
  form.append('coupon', couponId);
  form.append('code', code.toUpperCase());
  const data = await stripeForm(secretKey, '/promotion_codes', form);
  return data.id as string;
}

/** Activate or deactivate a promotion code (pause/reactivate an affiliate). */
export async function setPromotionCodeActive(
  secretKey: string,
  promotionCodeId: string,
  active: boolean,
): Promise<void> {
  const form = new URLSearchParams();
  form.append('active', String(active));
  await stripeForm(secretKey, `/promotion_codes/${promotionCodeId}`, form);
}

/** Thrown when a webhook payload fails signature/timestamp verification. */
export class SignatureError extends Error {}

// Constant-time-ish compare of two hex strings.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Stripe webhook signature over the raw body and return the parsed
 * event. Mirrors stripe.webhooks.constructEvent: HMAC-SHA256 of `t.payload`
 * against the v1 signature(s), with a replay-window check.
 */
export async function constructEvent(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): Promise<Record<string, unknown>> {
  let timestamp = '';
  const v1: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === 't') timestamp = val;
    else if (k === 'v1') v1.push(val);
  }
  if (!timestamp || v1.length === 0) throw new SignatureError('Malformed Stripe-Signature header');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = hex(sig);
  if (!v1.some((candidate) => safeEqual(expected, candidate))) {
    throw new SignatureError('Signature mismatch');
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    throw new SignatureError('Timestamp outside tolerance');
  }

  return JSON.parse(rawBody) as Record<string, unknown>;
}
