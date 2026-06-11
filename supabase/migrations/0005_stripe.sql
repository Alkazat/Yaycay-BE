-- 0005_stripe.sql
-- Commerce wiring for Stripe Checkout + webhook entitlement.
--
-- Each catalogue product maps to the tier it grants, so `/checkout/session` can
-- validate the price and the `/webhooks/stripe` handler knows which entitlement
-- to confer. Purchases are written by the webhook via the service role; the
-- existing unique stripe_session_id / stripe_payment_intent columns make that
-- write idempotent, so a redelivered event never double-applies.

alter table public.products
  add column if not exists tier public.trip_tier;

-- A trip's paid entitlement is its `tier` column (free -> byo|ours), flipped by
-- the webhook on a completed checkout. No new tables or policies are required:
-- products are readable by signed-in clients (catalogue), purchases are
-- owner-select, and both are written only by admin / the service role.
