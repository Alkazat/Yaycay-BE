// POST /checkout/session - create a Stripe Checkout Session for a price.
//
// User-scoped (the gateway verifies the JWT; we run as the caller). The price
// must be a known, active catalogue product; its mapped tier is carried in the
// session metadata so the webhook can confer entitlement on success. We never
// flip the trip tier here - only the signed `checkout.session.completed`
// webhook does, so entitlement can't be spoofed from the client.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { optionalEnv } from '../_shared/env.ts';
import { createCheckoutSession, stripeConfigured, stripeLivemode } from '../_shared/stripe.ts';
import { serviceClient } from '../_shared/service-client.ts';

interface ProductRow {
  price_id: string;
  tier: string | null;
  active: boolean;
  kind: string;
  extends_months: number | null;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);

  try {
    if (!stripeConfigured()) {
      return error('payments_unavailable', 'Payments are not configured.', 503);
    }

    const { client, userId } = await userContext(req);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return error('validation_error', 'Request body must be JSON.', 422);
    }

    const priceId = typeof body.price_id === 'string' ? body.price_id.trim() : '';
    if (!priceId) return error('validation_error', 'price_id is required.', 422, ['price_id']);

    const successUrl =
      (typeof body.success_url === 'string' && body.success_url) ||
      optionalEnv('CHECKOUT_SUCCESS_URL');
    const cancelUrl =
      (typeof body.cancel_url === 'string' && body.cancel_url) ||
      optionalEnv('CHECKOUT_CANCEL_URL');
    if (!successUrl || !cancelUrl) {
      return error('validation_error', 'success_url and cancel_url are required.', 422, [
        'success_url',
        'cancel_url',
      ]);
    }

    // The price must be a known, active product; its kind decides what the
    // webhook grants - a tier entitlement, or a keep-token retention extension.
    const { data: product, error: prodErr } = await client
      .from('products')
      .select('price_id, tier, active, kind, extends_months')
      .eq('price_id', priceId)
      .eq('livemode', stripeLivemode())
      .maybeSingle();
    if (prodErr) throw new Error(prodErr.message);
    const p = product as ProductRow | null;
    if (!p || !p.active) {
      return error('unknown_price', 'No such purchasable product.', 400, [priceId]);
    }

    // Trip scoping. A keep-token always applies to a specific trip; tier
    // products may carry a trip but don't require one. If given, the caller must
    // own the trip (RLS hides others').
    const tripId = typeof body.trip_id === 'string' ? body.trip_id : undefined;
    if (p.kind === 'keep' && !tripId) {
      return error('validation_error', 'trip_id is required to buy a keep-token.', 422, [
        'trip_id',
      ]);
    }
    if (tripId) {
      const { data: trip } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
      if (!trip) return error('not_found', 'Trip not found or not visible to the caller.', 404);
    }

    // Metadata is echoed back on the webhook event; it is what confers
    // entitlement, so it carries everything the webhook needs to act.
    const metadata: Record<string, string> = { user_id: userId, price_id: priceId, kind: p.kind };
    if (tripId) metadata.trip_id = tripId;
    if (p.kind === 'tier' && p.tier) metadata.tier = p.tier;
    if (p.kind === 'keep' && p.extends_months) metadata.extends_months = String(p.extends_months);

    // Optional affiliate code (from the Website /go/<slug> funnel). Resolve the
    // affiliate's Stripe promotion code via the service role (affiliates are
    // admin-RLS, not readable by the caller); apply it and tag the session so the
    // webhook can attribute the redemption. An unknown/inactive code is ignored.
    let promotionCode: string | undefined;
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (code) {
      const { data: aff } = await serviceClient()
        .from('affiliates')
        .select('code, stripe_promotion_code_id, status')
        .eq('code', code)
        .eq('status', 'active')
        .maybeSingle();
      if (aff?.stripe_promotion_code_id) {
        promotionCode = aff.stripe_promotion_code_id as string;
        metadata.discount_code = code;
      }
    }

    const session = await createCheckoutSession(optionalEnv('STRIPE_SECRET_KEY')!, {
      priceId,
      successUrl,
      cancelUrl,
      clientReferenceId: userId,
      metadata,
      promotionCode,
    });

    return json({ url: session.url, session_id: session.id }, 200);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('checkout handler error', err);
    return error('internal_error', 'Could not create a checkout session.', 500);
  }
});
