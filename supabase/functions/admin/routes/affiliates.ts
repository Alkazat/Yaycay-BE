// /admin/affiliates - the affiliate/influencer program. Create an affiliate
// (and its Stripe coupon + promotion code), list/inspect, edit, pause/reactivate,
// archive, read attributed redemptions, and send the monthly commission report
// (Brevo). All admin+AAL2 gated by requireAdmin; writes are audited.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable, conflict, ProblemError } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';
import {
  createCoupon,
  createPromotionCode,
  findPromotionCode,
  setPromotionCodeActive,
} from '../../_shared/stripe.ts';
import { sendEmail } from '../../_shared/brevo.ts';

const AFFILIATE_COLUMNS =
  'id, name, email, handle, code, discount_percent, commission_percent, landing_slug, stripe_promotion_code_id, status, archived_at, created_at';

interface AffiliateRow {
  id: string;
  name: string;
  email: string;
  handle: string;
  code: string;
  discount_percent: number;
  commission_percent: number;
  landing_slug: string;
  stripe_promotion_code_id: string | null;
  status: string;
  archived_at: string | null;
  created_at: string;
}

function toAffiliate(r: AffiliateRow) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    handle: r.handle,
    code: r.code,
    discountPercent: r.discount_percent,
    commissionPercent: r.commission_percent,
    landingSlug: r.landing_slug,
    status: r.status,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function intInRange(v: unknown, lo: number, hi: number): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

function stripeKey(): string {
  // Affiliate coupon/promotion-code operations use a dedicated restricted key
  // scoped to Coupons + Promotion codes (write), so the main STRIPE_SECRET_KEY
  // used for Checkout needn't carry those permissions. Fall back to
  // STRIPE_SECRET_KEY when the dedicated key isn't configured.
  const key = Deno.env.get('STRIPE_COUPON_KEY') || Deno.env.get('STRIPE_SECRET_KEY') || '';
  if (!key) {
    throw new ProblemError(503, 'Service Unavailable', 'Stripe coupon key is not configured.');
  }
  return key;
}

export async function listAffiliates(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const params = parsePageParams(url);
  // Archived affiliates are hidden by default; ?includeArchived=true shows them.
  const includeArchived = url.searchParams.get('includeArchived') === 'true';
  let q = serviceClient()
    .from('affiliates')
    .select(AFFILIATE_COLUMNS)
    .order('created_at', { ascending: false });
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  return ok(page((data as AffiliateRow[]).map(toAffiliate), params));
}

export async function createAffiliate(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readJson(req);
  const name = str(body.name);
  const email = str(body.email);
  const handle = str(body.handle);
  if (!name) throw unprocessable('name is required');
  if (!email) throw unprocessable('email is required');
  if (!handle) throw unprocessable('handle is required');
  const discountPercent = intInRange(body.discountPercent, 0, 100);
  const commissionPercent = intInRange(body.commissionPercent, 0, 100);
  if (discountPercent === null) throw unprocessable('discountPercent must be 0-100');
  if (commissionPercent === null) throw unprocessable('commissionPercent must be 0-100');

  // BE owns code/slug uniqueness; the Admin-supplied values are hints.
  const code = (str(body.code) || `${slug(handle)}${discountPercent}`).toUpperCase();
  const landingSlug = slug(str(body.landingSlug) || handle);
  if (!code) throw unprocessable('could not derive a code');
  if (!landingSlug) throw unprocessable('could not derive a landing slug');

  const db = serviceClient();

  // Reject a duplicate up front so a retry never orphans a second Stripe coupon.
  const { data: dups, error: dupErr } = await db
    .from('affiliates')
    .select('id')
    .or(`code.eq.${code},landing_slug.eq.${landingSlug}`)
    .limit(1);
  if (dupErr) throw badRequest(dupErr.message);
  if (dups && dups.length > 0) throw conflict('That code or landing slug is already in use.');

  // Create (or recover) the Stripe coupon + promotion code before saving the
  // row, so a stored affiliate never points at a non-existent promo. Stripe
  // failures surface as a 502 with Stripe's own message rather than an opaque
  // 500. A prior attempt that created the coupon but failed before the insert
  // leaves an orphaned promo code; reuse it instead of colliding on the retry.
  const key = stripeKey();
  let couponId = '';
  let promoId = '';
  try {
    const orphan = await findPromotionCode(key, code);
    if (orphan) {
      couponId = orphan.couponId;
      promoId = orphan.id;
    } else {
      couponId = await createCoupon(key, discountPercent, name);
      promoId = await createPromotionCode(key, couponId, code);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProblemError(
      502,
      'Bad Gateway',
      `Stripe error creating the affiliate coupon: ${msg}`,
    );
  }

  const { data, error } = await db
    .from('affiliates')
    .insert({
      name,
      email,
      handle,
      code,
      discount_percent: discountPercent,
      commission_percent: commissionPercent,
      landing_slug: landingSlug,
      stripe_coupon_id: couponId,
      stripe_promotion_code_id: promoId,
      status: 'active',
    })
    .select(AFFILIATE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict('Code or landing slug already in use.');
    }
    throw badRequest(error.message);
  }

  await writeAudit(ctx, {
    action: 'affiliate.create',
    targetType: 'affiliate',
    targetId: code,
    after: data,
  });
  return ok(toAffiliate(data as AffiliateRow), 201);
}

export async function getAffiliate(
  _req: Request,
  _ctx: AdminContext,
  code: string,
): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('affiliates')
    .select(AFFILIATE_COLUMNS)
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Affiliate not found.');
  return ok(toAffiliate(data as AffiliateRow));
}

export async function setAffiliateStatus(
  req: Request,
  ctx: AdminContext,
  code: string,
): Promise<Response> {
  const body = await readJson(req);
  const status = str(body.status);
  if (status !== 'active' && status !== 'paused') {
    throw unprocessable('status must be active or paused');
  }

  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from('affiliates')
    .select('code, status, archived_at, stripe_promotion_code_id')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) throw notFound('Affiliate not found.');
  if (existing.archived_at) {
    throw conflict('Affiliate is archived; status cannot be changed.');
  }

  // Toggle the Stripe promotion code so a paused affiliate stops redeeming.
  if (existing.stripe_promotion_code_id) {
    await setPromotionCodeActive(
      stripeKey(),
      existing.stripe_promotion_code_id as string,
      status === 'active',
    );
  }

  const { data, error } = await db
    .from('affiliates')
    .update({ status })
    .eq('code', code.toUpperCase())
    .select(AFFILIATE_COLUMNS)
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'affiliate.status',
    targetType: 'affiliate',
    targetId: code.toUpperCase(),
    before: { status: existing.status },
    after: { status },
  });
  return ok(toAffiliate(data as AffiliateRow));
}

// PUT /admin/affiliates/{code} - edit mutable metadata. The discount and code
// are fixed by the Stripe coupon/promotion code (both immutable in Stripe), so
// they cannot be changed here; archive and recreate to change them.
export async function updateAffiliate(
  req: Request,
  ctx: AdminContext,
  code: string,
): Promise<Response> {
  const body = await readJson(req);
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from('affiliates')
    .select(AFFILIATE_COLUMNS)
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) throw notFound('Affiliate not found.');
  const before = existing as AffiliateRow;

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const v = str(body.name);
    if (!v) throw unprocessable('name cannot be empty');
    patch.name = v;
  }
  if (body.email !== undefined) {
    const v = str(body.email);
    if (!v) throw unprocessable('email cannot be empty');
    patch.email = v;
  }
  if (body.handle !== undefined) {
    const v = str(body.handle);
    if (!v) throw unprocessable('handle cannot be empty');
    patch.handle = v;
  }
  if (body.commissionPercent !== undefined) {
    const v = intInRange(body.commissionPercent, 0, 100);
    if (v === null) throw unprocessable('commissionPercent must be 0-100');
    patch.commission_percent = v;
  }
  if (body.landingSlug !== undefined) {
    const v = slug(str(body.landingSlug));
    if (!v) throw unprocessable('landingSlug cannot be empty');
    if (v !== before.landing_slug) {
      const { data: dups, error: dupErr } = await db
        .from('affiliates')
        .select('id')
        .eq('landing_slug', v)
        .limit(1);
      if (dupErr) throw badRequest(dupErr.message);
      if (dups && dups.length > 0) throw conflict('That landing slug is already in use.');
    }
    patch.landing_slug = v;
  }
  // The Stripe coupon (percent_off) and promotion code (code) are immutable.
  if (
    body.discountPercent !== undefined &&
    Number(body.discountPercent) !== before.discount_percent
  ) {
    throw unprocessable(
      'discountPercent cannot be changed after creation (the Stripe coupon is immutable); archive and recreate to change the discount.',
    );
  }
  if (body.code !== undefined && str(body.code).toUpperCase() !== before.code) {
    throw unprocessable(
      'code cannot be changed after creation (the Stripe promotion code is immutable); archive and recreate to change the code.',
    );
  }

  if (Object.keys(patch).length === 0) return ok(toAffiliate(before));

  const { data, error } = await db
    .from('affiliates')
    .update(patch)
    .eq('code', code.toUpperCase())
    .select(AFFILIATE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict('Landing slug already in use.');
    }
    throw badRequest(error.message);
  }

  await writeAudit(ctx, {
    action: 'affiliate.update',
    targetType: 'affiliate',
    targetId: code.toUpperCase(),
    before: toAffiliate(before),
    after: data,
  });
  return ok(toAffiliate(data as AffiliateRow));
}

// DELETE /admin/affiliates/{code} - archive (soft delete). Keeps the row and its
// attributed redemptions, hides it from the default list, and deactivates the
// Stripe promotion code so it stops redeeming. Idempotent.
export async function archiveAffiliate(
  _req: Request,
  ctx: AdminContext,
  code: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from('affiliates')
    .select('code, status, archived_at, stripe_promotion_code_id')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) throw notFound('Affiliate not found.');

  // Already archived: return the current row (idempotent, no audit churn).
  if (existing.archived_at) {
    const { data } = await db
      .from('affiliates')
      .select(AFFILIATE_COLUMNS)
      .eq('code', code.toUpperCase())
      .single();
    return ok(toAffiliate(data as AffiliateRow));
  }

  // Stop the code redeeming the moment it's archived.
  if (existing.stripe_promotion_code_id) {
    await setPromotionCodeActive(stripeKey(), existing.stripe_promotion_code_id as string, false);
  }

  const { data, error } = await db
    .from('affiliates')
    .update({ archived_at: new Date().toISOString(), status: 'paused' })
    .eq('code', code.toUpperCase())
    .select(AFFILIATE_COLUMNS)
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'affiliate.archive',
    targetType: 'affiliate',
    targetId: code.toUpperCase(),
    before: { status: existing.status, archivedAt: null },
    after: { status: 'paused', archivedAt: (data as AffiliateRow).archived_at },
  });
  return ok(toAffiliate(data as AffiliateRow));
}

interface RedemptionRow {
  id: string;
  user_id: string | null;
  price_id: string | null;
  gross_usd: string | number | null;
  discount_usd: string | number | null;
  amount_usd: string | number | null;
  created_at: string;
}

async function resolveEmails(
  db: ReturnType<typeof serviceClient>,
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return map;
  const { data } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email')
    .in('user_id', ids);
  for (const a of data ?? []) map.set(a.user_id, a.email);
  return map;
}

export async function listRedemptions(
  req: Request,
  _ctx: AdminContext,
  code: string,
): Promise<Response> {
  const params = parsePageParams(new URL(req.url));
  const db = serviceClient();
  const { data, error } = await db
    .from('purchases')
    .select('id, user_id, price_id, gross_usd, discount_usd, amount_usd, created_at')
    .eq('discount_code', code.toUpperCase())
    .order('created_at', { ascending: false })
    .range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = (data ?? []) as RedemptionRow[];
  const emails = await resolveEmails(
    db,
    rows.map((r) => r.user_id ?? ''),
  );

  const items = rows.map((r) => {
    const net = r.amount_usd != null ? Number(r.amount_usd) : 0;
    const discount = r.discount_usd != null ? Number(r.discount_usd) : 0;
    const gross = r.gross_usd != null ? Number(r.gross_usd) : net + discount;
    return {
      purchaseId: r.id,
      ownerEmail: r.user_id ? (emails.get(r.user_id) ?? '') : '',
      priceId: r.price_id ?? '',
      grossUsd: gross,
      discountUsd: discount,
      netUsd: net,
      createdAt: r.created_at,
    };
  });
  return ok(page(items, params));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function sendAffiliateReport(
  req: Request,
  ctx: AdminContext,
  code: string,
): Promise<Response> {
  const body = await readJson(req);
  const periodStart = str(body.periodStart);
  const periodEnd = str(body.periodEnd);
  if (!periodStart || !periodEnd) throw unprocessable('periodStart and periodEnd are required');

  const db = serviceClient();
  const { data: aff, error: affErr } = await db
    .from('affiliates')
    .select('code, name, email, commission_percent')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (affErr) throw badRequest(affErr.message);
  if (!aff) throw notFound('Affiliate not found.');

  // Redemptions in [periodStart, periodEnd) (end exclusive).
  const { data, error } = await db
    .from('purchases')
    .select('gross_usd, discount_usd, amount_usd')
    .eq('discount_code', code.toUpperCase())
    .gte('created_at', periodStart)
    .lt('created_at', periodEnd);
  if (error) throw badRequest(error.message);

  let gross = 0;
  let discount = 0;
  let net = 0;
  for (const r of data ?? []) {
    const n = r.amount_usd != null ? Number(r.amount_usd) : 0;
    const d = r.discount_usd != null ? Number(r.discount_usd) : 0;
    net += n;
    discount += d;
    gross += r.gross_usd != null ? Number(r.gross_usd) : n + d;
  }
  gross = round2(gross);
  discount = round2(discount);
  net = round2(net);
  const commissionOwed = round2((net * (aff.commission_percent as number)) / 100);

  const html =
    `<p>Hi ${aff.name},</p>` +
    `<p>Here's your Yaycay affiliate summary for ${periodStart} to ${periodEnd} (code <b>${aff.code}</b>):</p>` +
    `<ul>` +
    `<li>Gross revenue: $${gross.toFixed(2)}</li>` +
    `<li>Discounts given: $${discount.toFixed(2)}</li>` +
    `<li>Net revenue: $${net.toFixed(2)}</li>` +
    `<li>Commission (${aff.commission_percent}% of net): <b>$${commissionOwed.toFixed(2)}</b></li>` +
    `</ul>` +
    `<p>Thank you for partnering with Yaycay.</p>`;

  let sent = false;
  try {
    sent = await sendEmail({
      to: aff.email as string,
      subject: `Your Yaycay affiliate report (${periodStart} - ${periodEnd})`,
      html,
    });
  } catch (err) {
    console.error('affiliate report send failed', err);
    throw new ProblemError(502, 'Bad Gateway', 'Could not send the report email.');
  }
  if (!sent) {
    throw new ProblemError(503, 'Service Unavailable', 'Email sending is not configured.');
  }

  await writeAudit(ctx, {
    action: 'affiliate.report-send',
    targetType: 'affiliate',
    targetId: aff.code,
    after: { periodStart, periodEnd, grossUsd: gross, netUsd: net, commissionOwed },
  });
  return ok({ sent: true });
}
