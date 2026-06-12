-- 0009_phase2.sql
-- Phase 2: data retention/disposal, the keep-token upsell, and product kinds.
--
-- Two product kinds now coexist in the catalogue:
--   'tier' grants a trip entitlement (byo|ours) on purchase (Phase 1 behaviour);
--   'keep' is a keep-token that extends a trip's data retention by
--   `extends_months`, deferring disposal.
-- Every trip gets a disposal date on insert (12 months after the holiday).
-- The disposal job deletes anything past its retention date; a keep-token
-- purchase pushes that date forward so the family's memories are kept.

-- ----- product kinds -------------------------------------------------------
alter table public.products
  add column if not exists kind text not null default 'tier'
    check (kind in ('tier', 'keep')),
  add column if not exists extends_months int
    check (extends_months is null or extends_months > 0);

-- ----- retention default ---------------------------------------------------
-- A trip without an explicit disposal date is scheduled for deletion 12 months
-- after the holiday (or after today when undated). The keep-token path pushes
-- this out; the disposal job enforces it.
create or replace function app.set_trip_retention()
returns trigger
language plpgsql
as $$
begin
  if new.retention_expires_at is null then
    new.retention_expires_at :=
      (coalesce(new.end_date, new.start_date, current_date)::timestamptz
        + interval '12 months');
  end if;
  return new;
end;
$$;

drop trigger if exists trips_set_retention on public.trips;
create trigger trips_set_retention
  before insert on public.trips
  for each row execute function app.set_trip_retention();

-- Backfill trips created before the trigger existed.
update public.trips
   set retention_expires_at =
     (coalesce(end_date, start_date, created_at::date, current_date)::timestamptz
       + interval '12 months')
 where retention_expires_at is null;

-- ----- keep-token retention extension --------------------------------------
-- Adds months to a trip's retention, measured from the later of "now" and the
-- current expiry, so a keep-token always pushes the disposal date forward.
-- SECURITY DEFINER so a future in-DB caller can run it with owner rights; the
-- Stripe webhook performs the same extension via the service role.
create or replace function app.extend_trip_retention(p_trip_id uuid, p_months int)
returns timestamptz
language plpgsql
security definer
set search_path = public, app
as $$
declare
  new_expiry timestamptz;
begin
  update public.trips
     set retention_expires_at =
       greatest(coalesce(retention_expires_at, now()), now())
         + make_interval(months => p_months)
   where id = p_trip_id
   returning retention_expires_at into new_expiry;
  return new_expiry;
end;
$$;

revoke all on function app.extend_trip_retention(uuid, int) from public;
grant execute on function app.extend_trip_retention(uuid, int) to service_role;

-- ----- disposal job --------------------------------------------------------
-- Deletes every trip past its retention date and returns how many were removed.
-- Trip children (content, progress, ai_jobs, journal, connectors) cascade per
-- their FKs; purchases.trip_id is set null so the financial record survives.
-- SECURITY DEFINER so pg_cron can run it with owner rights.
create or replace function app.dispose_expired_trips()
returns integer
language plpgsql
security definer
set search_path = public, app
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.trips
      where retention_expires_at is not null
        and retention_expires_at < now()
      returning id
  )
  select count(*) from gone into removed;
  return removed;
end;
$$;

revoke all on function app.dispose_expired_trips() from public;
grant execute on function app.dispose_expired_trips() to service_role;

-- ----- daily schedule (best-effort) ----------------------------------------
-- Schedule the disposal sweep at 03:00 UTC daily when pg_cron is available.
-- Guarded so environments without pg_cron (or lacking privilege to create it)
-- still apply the migration; the `disposal` edge function is the portable
-- fallback trigger (call it from any external scheduler).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'yaycay-dispose-expired',
    '0 3 * * *',
    'select app.dispose_expired_trips();'
  );
exception when others then
  raise notice 'pg_cron not scheduled (%); use the disposal endpoint instead', sqlerrm;
end $$;
