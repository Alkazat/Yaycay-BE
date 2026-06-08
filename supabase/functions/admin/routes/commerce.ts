// /admin/products and /admin/purchases - read-mostly commerce views. Stripe is
// the source of truth; purchases are written by the Stripe webhook (Phase 1).

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest } from '../lib/http.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

export async function listProducts(_req: Request, _ctx: AdminContext): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('products')
    .select('price_id, name, amount_usd')
    .eq('active', true)
    .order('amount_usd', { ascending: true });
  if (error) throw badRequest(error.message);
  return ok({
    items: (data ?? []).map((p) => ({
      priceId: p.price_id,
      name: p.name,
      amountUsd: Number(p.amount_usd),
    })),
  });
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
