-- 0008_connectors.sql
-- BYO-AI MCP connectors (Phase 1, tier=byo).
--
-- A connector is a scoped grant: one trip, one owner. The minted token (signed
-- with MCP_TOKEN_SIGNING_SECRET, not stored) carries this row's id. The MCP
-- endpoint verifies the token, resolves the row to confirm it is not revoked,
-- and stamps last_used_at. `revoked_at is null` means active.

create table if not exists public.connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  label text,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists connectors_user_idx on public.connectors (user_id);
create index if not exists connectors_trip_idx on public.connectors (trip_id);

alter table public.connectors enable row level security;
alter table public.connectors force row level security;
drop policy if exists connectors_owner_all on public.connectors;
create policy connectors_owner_all on public.connectors
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.connectors to authenticated;
