-- 0015_product_livemode.sql
-- Scope the catalogue to a Stripe mode so each environment shows only its own
-- prices. The seed (0006) loaded BOTH the live and test price ids into every
-- environment (migrations run everywhere), so production /admin/products listed
-- all four. Tag each product with `livemode`; the API filters by the running
-- key's mode (live key on prod, test key on staging).

alter table public.products
  add column if not exists livemode boolean;

-- Backfill the seeded prices by their known ids (see 0006).
update public.products set livemode = true
 where price_id in ('price_1ThFAcGjtIPJuYSTQfVa1PKd', 'price_1ThFB2GjtIPJuYST55bM8RSg');

update public.products set livemode = false
 where price_id in ('price_1ThG9eGjtIPJuYSTUEiyk4da', 'price_1ThGA7GjtIPJuYST6asmTAQo');

create index if not exists products_livemode_idx on public.products (livemode);
