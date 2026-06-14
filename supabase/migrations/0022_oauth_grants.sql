-- 0022_oauth_grants.sql
-- Durable shared store for BYO-AI MCP OAuth grants. The FE's MCP server creates
-- a row per grant (OAuth dynamic client registration), stamps last_used_at on
-- each tool call, and checks status='active' + token_version in verifyMcpToken.
-- Admin owns the cross-account list + revoke kill-switch (over this table).
--
-- This is distinct from the older trip-scoped public.connectors (0008): grants
-- here are account-scoped to a parent's connected assistant.

create table if not exists public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- OAuth client id (RFC 7591 dynamic registration).
  client_id text not null,
  -- Human label, e.g. "Claude (claude.ai)".
  assistant text not null default '',
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  -- Bumped on revoke so previously-issued tokens fail verification.
  token_version int not null default 1,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_grants_user_idx on public.oauth_grants (user_id);
create index if not exists oauth_grants_client_idx on public.oauth_grants (client_id);

-- ----- RLS -----------------------------------------------------------------
-- Owners read their own grants (FE self-service); admins read all. All writes
-- (create on OAuth grant, last_used_at stamps, revoke) go through the service
-- role from the MCP server / admin surface.
alter table public.oauth_grants enable row level security;
alter table public.oauth_grants force row level security;
drop policy if exists oauth_grants_owner_select on public.oauth_grants;
create policy oauth_grants_owner_select on public.oauth_grants
  for select
  using (user_id = auth.uid() or app.is_admin());

grant select on public.oauth_grants to authenticated;

-- ----- ai_jobs: mark connector-driven work ---------------------------------
-- ai_jobs.source already exists (0002). Add the connector attribution so ops can
-- see which assistant drove a plan_trip write; the daily cap counts these too.
alter table public.ai_jobs
  add column if not exists connector_id uuid references public.oauth_grants (id) on delete set null,
  add column if not exists assistant text;
