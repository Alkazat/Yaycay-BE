-- 0023_oauth_sweep.sql
-- Housekeeping for the BYO-AI OAuth store (see 0022_oauth.sql and
-- docs/handoff/MCP-CONNECTOR-BE-RESPONSE.md item 4 / BE next-step 4).
--
-- Authorization codes are single-use and short-lived, but an abandoned flow
-- leaves a row behind, and revoked grants accumulate. This sweep deletes expired
-- codes and prunes grants that were revoked long enough ago to be uninteresting
-- (revocation takes effect immediately via revoked_at; this only reclaims the
-- row later). It mirrors the retention disposal pattern: a SECURITY DEFINER
-- function plus a best-effort pg_cron schedule, guarded so environments without
-- pg_cron still apply the migration.

create or replace function app.sweep_oauth()
returns integer
language plpgsql
security definer
set search_path = public, app
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.oauth_codes
      where expires_at < now()
      returning code
  )
  select count(*) from gone into removed;

  -- Reclaim grants revoked more than 30 days ago. They are already inert
  -- (verifyMcpToken rejects revoked_at is not null); this just keeps the table
  -- lean and the "Connected assistants" list focused on live grants.
  delete from public.oauth_grants
    where revoked_at is not null
      and revoked_at < now() - interval '30 days';

  return removed;
end;
$$;

revoke all on function app.sweep_oauth() from public;
grant execute on function app.sweep_oauth() to service_role;

-- ----- schedule (best-effort) ----------------------------------------------
-- Sweep every 15 minutes when pg_cron is available. Codes have a short TTL, so a
-- frequent, cheap sweep keeps oauth_codes from holding stale single-use rows.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'yaycay-sweep-oauth',
    '*/15 * * * *',
    'select app.sweep_oauth();'
  );
exception when others then
  raise notice 'pg_cron not scheduled (%); call select app.sweep_oauth() from a scheduler instead', sqlerrm;
end $$;
