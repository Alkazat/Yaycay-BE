-- 0006_products_seed.sql
-- Catalogue seed: map each Stripe price to the tier it grants, so
-- `/checkout/session` accepts it and the webhook confers the right entitlement.
--
-- `amount_usd` is the catalogue display value only; the customer is charged the
-- Stripe price. Idempotent upsert, so this is safe to re-run on every deploy and
-- names/amounts can be edited here. Live-mode prices (different ids) are added
-- as additional rows when production goes live; test and live rows coexist.

insert into public.products (price_id, name, amount_usd, tier, active) values
  ('price_1ThFAcGjtIPJuYSTQfVa1PKd', 'Use Our AI', 49.00, 'ours', true),
  ('price_1ThFB2GjtIPJuYST55bM8RSg', 'Bring Your Own AI', 29.00, 'byo', true)
on conflict (price_id) do update
  set name = excluded.name,
      amount_usd = excluded.amount_usd,
      tier = excluded.tier,
      active = excluded.active;
