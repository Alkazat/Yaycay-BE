-- 0027_oauth_store_role.sql
-- Least-privilege DB role for the FE OAuth store, so the FE no longer needs the
-- master service_role key (which bypasses RLS on the WHOLE database). This role
-- can touch ONLY the three oauth_* tables, is subject to RLS (no BYPASSRLS), and
-- gets there through explicit policies scoped to it alone. If the FE's key for
-- this role ever leaks from Vercel, the blast radius is those three tables.
--
-- ADDITIVE + INERT: nothing uses this role until the FE is pointed at a JWT
-- minted for it (role claim = 'oauth_store'). Until then the FE keeps using the
-- service_role key, so this migration changes no behaviour on its own.

-- The role: no login (it is assumed via a signed JWT through PostgREST, never a
-- password connection).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'oauth_store') then
    create role oauth_store nologin;
  end if;
end $$;

-- PostgREST connects as `authenticator` and SET ROLE to the JWT's `role` claim;
-- it can only switch into roles it is a member of. (Guarded: `authenticator`
-- exists on Supabase + the local CI stack, but not on a bare Postgres.)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant oauth_store to authenticator;
  end if;
end $$;

-- Table privileges. RLS still applies on top of these (policies below).
grant usage on schema public to oauth_store;
grant select, insert, update, delete
  on public.oauth_clients, public.oauth_codes, public.oauth_grants
  to oauth_store;

-- The oauth_grants UPDATE trigger calls app.touch_updated_at(); make sure the
-- role can reach it (harmless if the function is SECURITY DEFINER).
grant usage on schema app to oauth_store;
grant execute on function app.touch_updated_at() to oauth_store;

-- RLS: these tables are FORCE RLS with no policies (service_role bypasses via its
-- BYPASSRLS attribute). oauth_store has no bypass, so it needs explicit policies.
-- Scope them `to oauth_store` ONLY: no other role gains anything, and the role
-- gains nothing on any other table.
do $$
declare
  t text;
begin
  foreach t in array array['oauth_clients', 'oauth_codes', 'oauth_grants'] loop
    execute format('drop policy if exists %I_oauth_store_all on public.%I;', t, t);
    execute format(
      'create policy %I_oauth_store_all on public.%I for all to oauth_store '
        || 'using (true) with check (true);',
      t, t
    );
  end loop;
end $$;
