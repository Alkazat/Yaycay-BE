-- 0013_expose_identity_api.sql
-- Expose the isolated `identity` schema to the REST API.
--
-- The admin surface resolves role/email from `identity.accounts` over PostgREST
-- (requireAdmin, plus the admin trips/customers/commerce reads). On hosted
-- Supabase, PostgREST only routes to schemas listed in the `authenticator`
-- role's `pgrst.db_schemas` GUC. `config.toml`'s `[api] schemas` (which includes
-- identity) governs LOCAL dev only and is never applied by `supabase db push`,
-- so on the deployed projects those queries failed with PGRST106 -> the handler
-- threw HTTP 500 "Could not verify admin role".
--
-- Exposing the schema only lets PostgREST route to it. Table access stays gated
-- by grants + RLS: 0001 revoked all privileges on identity.accounts from anon /
-- authenticated and only service_role can read, so isolation is unchanged.

-- PostgREST builds its schema cache as `authenticator`; it needs USAGE to see
-- the schema. Table privileges remain revoked (0001), so this grants no reads.
grant usage on schema identity to authenticator;

-- Add `identity` to the API-exposed schemas (keep the Supabase defaults).
do $$
begin
  alter role authenticator set pgrst.db_schemas = 'public, graphql_public, storage, identity';
exception when others then
  raise notice 'could not set pgrst.db_schemas (%); add identity under Settings -> API -> Exposed schemas in the dashboard',
    sqlerrm;
end $$;

-- Tell PostgREST to reload its config + schema cache.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
