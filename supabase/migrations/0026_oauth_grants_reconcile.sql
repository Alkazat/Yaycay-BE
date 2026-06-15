-- 0026_oauth_grants_reconcile.sql
-- Reconcile public.oauth_grants to the shape the FE durable OAuthStore actually
-- writes (Yaycay-FE lib/mcp/store.supabase.ts), so the BYO-AI OAuth connect
-- persists across serverless instances instead of dying as "invalid_client" /
-- failing at token exchange.
--
-- 0023 shipped a grants table keyed on a uuid `id`, with `access_token_expires_at`
-- and no encrypted-token / client_name / status columns. The FE store upserts on
-- a stable text `connection_id` and needs `access_token_enc` / `refresh_token_enc`,
-- `client_name`, a `status` enum, and `expires_at`. This unifies the two so BOTH
-- the FE AS and the BE admin ops view (functions/admin/routes/connectors.ts) read
-- one shape.
--
-- The table is empty in every environment (the durable store has never run - it
-- stays inert until SUPABASE_SERVICE_ROLE_KEY + OAUTH_ENC_KEY are set on the FE),
-- so we drop and recreate. Still secret-bearing and service-role only: RLS
-- enabled + forced, no policies, no grants (the AS and admin both reach it via
-- the service role, which bypasses RLS). app.sweep_oauth() from 0023 still
-- applies (revoked_at is preserved).

drop table if exists public.oauth_grants cascade;

create table public.oauth_grants (
  -- Stable connection id; survives token refresh. The FE upserts on this; the
  -- admin ops view uses it as the connector id to list / revoke.
  connection_id text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  -- Denormalised assistant label captured at registration (the FE writes it).
  client_name text,
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null,
  -- Issued MCP tokens: looked up by SHA-256 hash, stored encrypted at rest.
  access_token_hash text,
  refresh_token_hash text,
  access_token_enc text,
  refresh_token_enc text,
  -- The parent's captured Supabase tokens (encrypted), used to call the contract.
  supabase_access_token text,
  supabase_refresh_token text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Access-token expiry.
  expires_at timestamptz,
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

-- Secret-bearing: service-role only (same posture as 0023_oauth_store).
alter table public.oauth_grants enable row level security;
alter table public.oauth_grants force row level security;
