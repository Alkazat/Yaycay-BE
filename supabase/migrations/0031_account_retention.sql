-- 0031_account_retention.sql
-- Move the keep-data ("keep my memories") entitlement from per-trip to
-- ACCOUNT-level: one keep purchase preserves all of the customer's data.
--
-- Per-trip trips.retention_expires_at stays as the default auto-dispose timer
-- (12 months post-holiday). An account-level retention date now blankets every
-- trip the customer owns: the disposal sweep deletes a trip only when its own
-- window has lapsed AND the owner has no active account-level keep.

alter table identity.accounts
  add column if not exists retention_expires_at timestamptz;

-- Extend the account-level keep by N months, measured from the later of now and
-- the current expiry (so a keep purchase always pushes the date forward).
create or replace function app.extend_account_retention(p_user_id uuid, p_months int)
returns timestamptz
language plpgsql
security definer
set search_path = identity, public, app
as $$
declare
  new_expiry timestamptz;
begin
  update identity.accounts
     set retention_expires_at =
       greatest(coalesce(retention_expires_at, now()), now())
         + make_interval(months => p_months)
   where user_id = p_user_id
   returning retention_expires_at into new_expiry;
  return new_expiry;
end;
$$;
revoke all on function app.extend_account_retention(uuid, int) from public;
grant execute on function app.extend_account_retention(uuid, int) to service_role;

-- Disposal now respects the account-level keep: never delete a trip whose owner
-- has an active account retention date, regardless of the trip's own window.
create or replace function app.dispose_expired_trips()
returns integer
language plpgsql
security definer
set search_path = public, app, identity
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.trips t
      where t.retention_expires_at is not null
        and t.retention_expires_at < now()
        and not exists (
          select 1
            from identity.accounts a
           where a.user_id = t.user_id
             and a.retention_expires_at is not null
             and a.retention_expires_at >= now()
        )
      returning t.id
  )
  select count(*) from gone into removed;
  return removed;
end;
$$;
revoke all on function app.dispose_expired_trips() from public;
grant execute on function app.dispose_expired_trips() to service_role;
