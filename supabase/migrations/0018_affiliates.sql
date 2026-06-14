-- 0018_affiliates.sql
-- Affiliate / influencer program. An affiliate has a discount code that is also
-- an attribution code: customers get `discount_percent` off, and the purchase is
-- attributed back so we can pay `commission_percent` on net revenue and email a
-- monthly report.
--
-- Redemptions are not a separate table - the webhook stamps the applied
-- discount onto the `purchases` row, and the admin redemptions endpoint reads
-- purchases filtered by code. (A view would be equivalent; the handler join is
-- consistent with how /admin/purchases already resolves owner emails.)

create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  handle text not null,
  code text not null unique,
  discount_percent int not null check (discount_percent between 0 and 100),
  commission_percent int not null check (commission_percent between 0 and 100),
  landing_slug text not null unique,
  -- The Stripe coupon + promotion code created on affiliate creation.
  stripe_coupon_id text,
  stripe_promotion_code_id text,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists affiliates_code_idx on public.affiliates (code);

-- Attribution stamped on the purchase by the Stripe webhook.
alter table public.purchases
  add column if not exists discount_code text,
  add column if not exists discount_usd numeric(10, 2),
  add column if not exists gross_usd numeric(10, 2);
create index if not exists purchases_discount_code_idx on public.purchases (discount_code);

-- ----- RLS -----------------------------------------------------------------
-- Affiliates are admin-managed; the admin handlers use the service role and
-- enforce role=admin + AAL2 in code. RLS is the defense-in-depth backstop.
alter table public.affiliates enable row level security;
alter table public.affiliates force row level security;
drop policy if exists affiliates_admin_all on public.affiliates;
create policy affiliates_admin_all on public.affiliates
  for all using (app.is_admin()) with check (app.is_admin());

grant select, insert, update, delete on public.affiliates to authenticated;

drop trigger if exists affiliates_updated_at on public.affiliates;
create trigger affiliates_updated_at
  before update on public.affiliates
  for each row execute function app.touch_updated_at();
