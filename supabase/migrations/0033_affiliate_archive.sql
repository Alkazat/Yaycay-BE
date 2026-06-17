-- 0033_affiliate_archive.sql
-- Soft-delete (archive) support for affiliates. A dedicated timestamp lets the
-- admin list hide archived affiliates by default while keeping the row, its
-- Stripe coupon, and its attributed redemptions/history intact (we never hard-
-- delete revenue attribution). DELETE /admin/affiliates/{code} stamps
-- archived_at and deactivates the Stripe promotion code so it stops redeeming.

alter table public.affiliates
  add column if not exists archived_at timestamptz;

create index if not exists affiliates_archived_at_idx
  on public.affiliates (archived_at);
