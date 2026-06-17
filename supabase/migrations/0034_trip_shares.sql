-- 0034_trip_shares.sql
-- Public, revocable share links for a trip. A non-guessable token maps to one
-- trip; the public GET /shared/:token resolves it (read-only itinerary + the
-- owner's display name). Owner-scoped under RLS; the public resolver reads via
-- the service role. One active (non-revoked) share per trip.

create table if not exists public.trip_shares (
  token text primary key,
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists trip_shares_trip_idx on public.trip_shares (trip_id);
-- At most one active link per trip, so re-sharing reuses a stable URL.
create unique index if not exists trip_shares_one_active_per_trip
  on public.trip_shares (trip_id)
  where revoked_at is null;

-- ----- RLS: owner-or-admin manage; the public resolver uses the service role.
alter table public.trip_shares enable row level security;
alter table public.trip_shares force row level security;
drop policy if exists trip_shares_owner_all on public.trip_shares;
create policy trip_shares_owner_all on public.trip_shares
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

grant select, insert, update, delete on public.trip_shares to authenticated;
