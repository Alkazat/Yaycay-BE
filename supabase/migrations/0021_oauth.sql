-- 0021_oauth.sql
-- Durable store for the BYO-AI OAuth 2.1 authorization server (the FE ships the
-- AS + the remote MCP endpoint at /api/mcp; this is the shared, durable backing
-- it needs before production - see docs/handoff/MCP-CONNECTOR-BE-RESPONSE.md).
--
-- These tables are AS internals: registered clients (RFC 7591), short-lived
-- authorization codes (auth-code + PKCE S256), and issued grants. A grant
-- captures the parent's Supabase tokens so MCP tools can call the contract as
-- them. Everything here is secret-bearing, so the tables are locked to the
-- service role only: RLS is enabled and forced, and NO privileges are granted to
-- `authenticated` or `anon`. The AS (running server-side with the service-role
-- key) is the only caller; the service role bypasses RLS.
--
-- Sensitive token values (the parent's Supabase access/refresh tokens, and the
-- issued client tokens) must be stored as ciphertext or as a hash, never in the
-- clear: the AS encrypts the captured Supabase tokens application-side before
-- insert, and stores only a hash of the tokens it issues to the client (lookups
-- are by hash). Disk-at-rest encryption is a backstop, not a substitute.

-- ---------------------------------------------------------------------------
-- Registered clients (Dynamic Client Registration, RFC 7591)
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_clients (
  client_id text primary key,
  -- Null for public PKCE clients (token_endpoint_auth_method = 'none'). When a
  -- confidential client has a secret, store only its hash.
  client_secret_hash text,
  client_name text,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default '{authorization_code,refresh_token}',
  token_endpoint_auth_method text not null default 'none',
  -- Space-delimited registered scopes, e.g. 'yaycay.read yaycay.plan'.
  scope text not null default 'yaycay.read',
  -- The raw registration request, kept for forward-compatibility.
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Authorization codes (single-use, short TTL; deleted on exchange)
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_codes (
  -- The authorization code value (or its hash). Single-use: delete on exchange.
  code text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  -- The parent who approved on the consent screen.
  user_id uuid not null references auth.users (id) on delete cascade,
  redirect_uri text not null,
  scope text not null,
  -- PKCE (S256 only).
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  -- The parent's Supabase tokens captured at consent (ciphertext), carried onto
  -- the grant at exchange time.
  supabase_access_token text,
  supabase_refresh_token text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_codes_expires_idx on public.oauth_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Issued grants (one per connected assistant; backs token validation +
-- refresh-token rotation + the "Connected assistants" management surface)
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  -- Hashes of the tokens issued to the client (validated by hash lookup).
  access_token_hash text,
  refresh_token_hash text,
  access_token_expires_at timestamptz,
  -- The parent's Supabase tokens (ciphertext) so tools can act as them. The
  -- preferred end-state is BE-minted, user-scoped short-lived tokens per grant,
  -- which lets us stop persisting the parent's refresh token (this column then
  -- goes unused) - see the handoff response, item 2.
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

create trigger oauth_grants_updated_at
  before update on public.oauth_grants
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Lock down: service-role only. Enable + force RLS and grant no privileges to
-- authenticated/anon, so only the AS (service-role, which bypasses RLS) reads or
-- writes these secret-bearing rows. No policies are defined deliberately.
-- ---------------------------------------------------------------------------
alter table public.oauth_clients enable row level security;
alter table public.oauth_clients force row level security;
alter table public.oauth_codes enable row level security;
alter table public.oauth_codes force row level security;
alter table public.oauth_grants enable row level security;
alter table public.oauth_grants force row level security;
