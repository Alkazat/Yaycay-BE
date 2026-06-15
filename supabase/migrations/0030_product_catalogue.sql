-- 0030_product_catalogue.sql
-- Stable product catalogue: maps a contract ProductId (e.g. 'price_holiday_ai')
-- to the live Stripe price id, plus display label/amount. The FE paywall reads
-- this (GET /catalogue) to render buttons and to resolve a product_id to its
-- Stripe price for /checkout/session.
--
-- Why a separate table from public.products: products is keyed by the Stripe
-- price id (and only exists once a real price is created). The catalogue is
-- keyed by the stable contract key so the FE can reference products before ops
-- has wired the live Stripe price (stripe_price_id stays null until then).
--
-- OPS: create the live Stripe prices, add them to public.products (price_id,
-- tier, kind, active, livemode), then set product_catalogue.stripe_price_id to
-- that price id. Until stripe_price_id is set, /checkout/session returns
-- "Product is not available" for that product_id and the paywall button is
-- disabled. Display amounts below are catalogue values only.

create table if not exists public.product_catalogue (
  product_id text primary key,
  label text not null,
  amount_usd numeric(10, 2),
  currency text not null default 'USD',
  stripe_price_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists product_catalogue_updated_at on public.product_catalogue;
create trigger product_catalogue_updated_at
  before update on public.product_catalogue
  for each row execute function app.touch_updated_at();

-- Seed the catalogue. stripe_price_id is left null for ops to fill; the
-- on-conflict deliberately does NOT touch stripe_price_id/active so a re-deploy
-- never clobbers what ops set.
insert into public.product_catalogue (product_id, label, amount_usd) values
  ('price_holiday_ai', 'Holiday, our AI chat', 129.00),
  ('price_holiday_byo', 'Holiday, bring your own AI', 59.00),
  ('price_datakeep_annual', 'Keep data, +12 months', 9.00),
  ('price_destination_addon', 'Destination add-on', null),
  ('price_photobook', 'Photobook', null)
on conflict (product_id) do update
  set label = excluded.label,
      amount_usd = excluded.amount_usd;

-- ----- RLS: public read (no secrets); writes via service role only ----------
alter table public.product_catalogue enable row level security;
alter table public.product_catalogue force row level security;
drop policy if exists product_catalogue_read on public.product_catalogue;
create policy product_catalogue_read on public.product_catalogue
  for select
  using (true);
grant select on public.product_catalogue to anon, authenticated;
