-- 0006_products_seed.sql
-- Catalogue seed: map each Stripe price to the tier it grants, so
-- `/checkout/session` accepts it and the webhook confers the right entitlement.
--
-- `amount_usd` is the catalogue display value only; the customer is charged the
-- Stripe price. Idempotent upsert, safe to re-run on every deploy. Both live and
-- test (sandbox) price ids are seeded so each environment resolves its own:
-- staging runs Stripe in test mode and uses the test ids; production runs live
-- and uses the live ids. Price ids are globally unique, so the rows coexist.

insert into public.products (price_id, name, amount_usd, tier, active) values
  -- Live (production)
  ('price_1ThFAcGjtIPJuYSTQfVa1PKd', 'Use Our AI', 49.00, 'ours', true),
  ('price_1ThFB2GjtIPJuYST55bM8RSg', 'Bring Your Own AI', 29.00, 'byo', true),
  -- Test / sandbox (staging)
  ('price_1ThG9eGjtIPJuYSTUEiyk4da', 'Use Our AI', 49.00, 'ours', true),
  ('price_1ThGA7GjtIPJuYST6asmTAQo', 'Bring Your Own AI', 29.00, 'byo', true)
on conflict (price_id) do update
  set name = excluded.name,
      amount_usd = excluded.amount_usd,
      tier = excluded.tier,
      active = excluded.active;
