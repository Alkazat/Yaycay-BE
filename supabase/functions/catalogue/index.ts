// GET /catalogue - the public product catalogue.
//
// Maps each stable contract ProductId to its live Stripe price (when ops has
// wired one) plus a display label/amount. The paywall reads this pre-login to
// render buttons and to resolve a product_id to a price for /checkout/session.
// Public (verify_jwt=false); the catalogue holds no secrets (Stripe price ids
// are client-side anyway). Only active products are returned.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service-client.ts';

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'GET') return error('method_not_allowed', 'Use GET.', 405);

  try {
    const { data, error: dbErr } = await serviceClient()
      .from('product_catalogue')
      .select('product_id, label, amount_usd, currency, stripe_price_id, active')
      .eq('active', true)
      .order('product_id', { ascending: true });
    if (dbErr) throw new Error(dbErr.message);
    const products = (data ?? []).map((r) => ({
      product_id: r.product_id as string,
      label: r.label as string,
      amount_usd: r.amount_usd != null ? Number(r.amount_usd) : null,
      currency: r.currency as string,
      stripe_price_id: (r.stripe_price_id as string | null) ?? null,
      active: r.active as boolean,
    }));
    return json({ products });
  } catch (err) {
    console.error('catalogue error', err);
    return error('internal_error', 'Could not load the catalogue.', 500);
  }
});
