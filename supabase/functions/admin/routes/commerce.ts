// /admin/products and /admin/purchases - the commerce surface. Stripe is the
// payment source of truth; the catalogue (which price grants which entitlement)
// lives here and is managed from Admin. Purchases are written by the webhook.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const TIERS = ['byo', 'ours'];
const KINDS = ['tier', 'keep'];
const PRODUCT_COLUMNS = 'price_id, name, amount_usd, tier, kind, extends_months, active';

interface ProductRow {
  price_id: string;
  name: string;
  amount_usd: string | number;
  tier: string | null;
  kind: string | null;
  extends_months: number | null;
  active: boolean;
}

function toProductDto(p: ProductRow) {
  return {
    priceId: p.price_id,
    name: p.name,
    amountUsd: Number(p.amount_usd),
    tier: p.tier ?? undefined,
    kind: (p.kind ?? 'tier') as 'tier' | 'keep',
    extendsMonths: p.extends_months ?? null,
    active: p.active,
  };
}

// Catalogue management lists every product (active and inactive) so an admin can
// reactivate or retire a price; the customer catalogue read filters to active.
export async function listProducts(_req: Request, _ctx: AdminContext): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('products')
    .select(PRODUCT_COLUMNS)
    .order('amount_usd', { ascending: true });
  if (error) throw badRequest(error.message);
  return ok({ items: (data ?? []).map((p) => toProductDto(p as ProductRow)) });
}

export async function createProduct(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readJson(req);
  const priceId = str(body.priceId);
  const name = str(body.name);
  if (!priceId) throw unprocessable('priceId is required');
  if (!name) throw unprocessable('name is required');

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw unprocessable('amountUsd must be a non-negative number');
  }

  const kind = body.kind === undefined ? 'tier' : String(body.kind);
  if (!KINDS.includes(kind)) throw unprocessable('kind must be tier or keep');

  const { tier, extendsMonths } = entitlementFields(kind, body);
  const active = body.active === undefined ? true : Boolean(body.active);

  const db = serviceClient();
  const { data, error } = await db
    .from('products')
    .insert({
      price_id: priceId,
      name,
      amount_usd: amountUsd,
      tier: tier ?? null,
      kind,
      extends_months: extendsMonths,
      active,
    })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw badRequest('A product with that priceId already exists.');
    }
    throw badRequest(error.message);
  }

  await writeAudit(ctx, {
    action: 'product.create',
    targetType: 'product',
    targetId: priceId,
    after: data,
  });
  return ok(toProductDto(data as ProductRow), 201);
}

export async function updateProduct(
  req: Request,
  ctx: AdminContext,
  priceId: string,
): Promise<Response> {
  const body = await readJson(req);
  const db = serviceClient();
  const { data: existing, error: exErr } = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('price_id', priceId)
    .maybeSingle();
  if (exErr) throw badRequest(exErr.message);
  if (!existing) throw notFound('Product not found.');

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const n = str(body.name);
    if (!n) throw unprocessable('name cannot be empty');
    patch.name = n;
  }
  if (body.amountUsd !== undefined) {
    const a = Number(body.amountUsd);
    if (!Number.isFinite(a) || a < 0)
      throw unprocessable('amountUsd must be a non-negative number');
    patch.amount_usd = a;
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (body.tier !== undefined) {
    if (body.tier !== null && !TIERS.includes(String(body.tier))) {
      throw unprocessable('tier must be byo or ours');
    }
    patch.tier = body.tier;
  }
  if (body.kind !== undefined) {
    if (!KINDS.includes(String(body.kind))) throw unprocessable('kind must be tier or keep');
    patch.kind = body.kind;
  }
  if (body.extendsMonths !== undefined) {
    if (body.extendsMonths === null) {
      patch.extends_months = null;
    } else {
      const m = Number(body.extendsMonths);
      if (!Number.isInteger(m) || m <= 0) {
        throw unprocessable('extendsMonths must be a positive integer');
      }
      patch.extends_months = m;
    }
  }
  if (Object.keys(patch).length === 0) throw unprocessable('No updatable fields provided.');

  const { data, error } = await db
    .from('products')
    .update(patch)
    .eq('price_id', priceId)
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'product.update',
    targetType: 'product',
    targetId: priceId,
    before: existing,
    after: data,
  });
  return ok(toProductDto(data as ProductRow));
}

interface PurchaseRow {
  id: string;
  user_id: string | null;
  price_id: string | null;
  tier: string | null;
  amount_usd: string | number | null;
  created_at: string;
}

export async function listPurchases(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);
  const db = serviceClient();

  let q = db
    .from('purchases')
    .select('id, user_id, price_id, tier, amount_usd, created_at')
    .order('created_at', { ascending: false });

  if (query.includes('@')) {
    const { data: accts } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id')
      .ilike('email', `%${query}%`);
    const ids = (accts ?? []).map((a) => a.user_id);
    if (ids.length === 0) return ok(page([], params));
    q = q.in('user_id', ids);
  } else if (query) {
    q = q.eq('price_id', query);
  }

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = data as PurchaseRow[];

  // Resolve owner emails from the identity store.
  const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
  const emailMap = new Map<string, string>();
  if (ids.length > 0) {
    const { data: accts } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id, email')
      .in('user_id', ids);
    for (const a of accts ?? []) emailMap.set(a.user_id, a.email);
  }

  return ok(
    page(
      rows.map((r) => ({
        id: r.id,
        ownerEmail: r.user_id ? (emailMap.get(r.user_id) ?? '') : '',
        priceId: r.price_id ?? '',
        tier: r.tier,
        amountUsd: r.amount_usd != null ? Number(r.amount_usd) : 0,
        createdAt: r.created_at,
      })),
      params,
    ),
  );
}

// ----- helpers ---------------------------------------------------------------

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// A tier product grants byo|ours; a keep-token extends retention by a positive
// number of months. Validate the entitlement fields against the product kind.
function entitlementFields(
  kind: string,
  body: Record<string, unknown>,
): { tier: string | undefined; extendsMonths: number | null } {
  if (kind === 'keep') {
    const m = Number(body.extendsMonths);
    if (!Number.isInteger(m) || m <= 0) {
      throw unprocessable('extendsMonths must be a positive integer for a keep-token');
    }
    return { tier: undefined, extendsMonths: m };
  }
  // tier product
  const tier = body.tier === undefined ? undefined : String(body.tier);
  if (tier !== undefined && !TIERS.includes(tier)) throw unprocessable('tier must be byo or ours');
  return { tier, extendsMonths: null };
}
