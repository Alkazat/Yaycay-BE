-- 0023_oauth_store.sql
-- Canonical durable store for the BYO-AI OAuth 2.1 authorization server (the FE
-- ships the AS + the remote MCP endpoint; this is the shared, durable backing it
-- needs - see docs/handoff/MCP-CONNECTOR-BE-RESPONSE.md and BACKEND-STORES.md).
--
-- Reconciliation note: an earlier 0022_oauth_grants.sql shipped a lighter,
-- account-scoped oauth_grants. This supersedes it with the fuller AS schema
-- (clients + auth codes + grants, token hashes, PKCE, captured Supabase tokens).
-- We drop the legacy table first (it is empty in every environment - the FE MCP
-- server had not started writing it), then create the canonical schema. Written
-- idempotently (if-not-exists, drop-trigger-if-exists) so the FE-thread's own
-- OAuth migrations remain harmless no-ops wherever they land.
--
-- Everything here is secret-bearing (the parent's Supabase tokens, issued token
-- hashes), so the tables are locked to the service role only: RLS enabled +
-- forced, NO privileges to authenticated/anon, no policies. The AS runs with the
-- service-role key (which bypasses RLS) and is the only caller.

-- Shed the legacy account-scoped table (drops its ai_jobs FK via cascade; the
-- connector_id column is re-added below, FK-less).
drop table if exists public.oauth_grants cascade;

-- ----- registered clients (Dynamic Client Registration, RFC 7591) ----------
create table if not exists public.oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  client_name text,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default '{authorization_code,refresh_token}',
  token_endpoint_auth_method text not null default 'none',
  scope text not null default 'yaycay.read',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ----- authorization codes (single-use, short TTL; deleted on exchange) -----
create table if not exists public.oauth_codes (
  code text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  redirect_uri text not null,
  scope text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  supabase_access_token text,
  supabase_refresh_token text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_codes_expires_idx on public.oauth_codes (expires_at);

-- ----- issued grants (one per connected assistant) -------------------------
create table if not exists public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  access_token_hash text,
  refresh_token_hash text,
  access_token_expires_at timestamptz,
  supabase_access_token text,
  supabase_refresh_token text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists oauth_grants_user_idx on public.oauth_grants (user_id);
create index if not exists oauth_grants_client_idx on public.oauth_grants (client_id);
create index if not exists oauth_grants_access_hash_idx on public.oauth_grants (access_token_hash);
create index if not exists oauth_grants_refresh_hash_idx on public.oauth_grants (refresh_token_hash);

drop trigger if exists oauth_grants_updated_at on public.oauth_grants;
create trigger oauth_grants_updated_at
  before update on public.oauth_grants
  for each row execute function app.touch_updated_at();

-- ----- lock down: service-role only ----------------------------------------
alter table public.oauth_clients enable row level security;
alter table public.oauth_clients force row level security;
alter table public.oauth_codes enable row level security;
alter table public.oauth_codes force row level security;
alter table public.oauth_grants enable row level security;
alter table public.oauth_grants force row level security;

-- ----- ai_jobs connector attribution (re-added; was in legacy 0022) ---------
-- source already exists (0002). connector_id is a plain attribution id (no FK,
-- so it survives grant pruning by the sweep).
alter table public.ai_jobs
  add column if not exists connector_id uuid,
  add column if not exists assistant text;

-- ----- housekeeping sweep (expired codes + long-revoked grants) -------------
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
    delete from public.oauth_codes where expires_at < now() returning code
  )
  select count(*) from gone into removed;

  delete from public.oauth_grants
    where revoked_at is not null
      and revoked_at < now() - interval '30 days';

  return removed;
end;
$$;

revoke all on function app.sweep_oauth() from public;
grant execute on function app.sweep_oauth() to service_role;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('yaycay-sweep-oauth', '*/15 * * * *', 'select app.sweep_oauth();');
exception when others then
  raise notice 'pg_cron not scheduled (%); call select app.sweep_oauth() from a scheduler instead', sqlerrm;
end $$;
