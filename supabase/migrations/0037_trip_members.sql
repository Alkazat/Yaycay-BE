-- 0037_trip_members.sql
-- Per-trip membership roster: each trip selects which profiles (explorers +
-- grown-ups) are on it. Profiles are shared account-wide via child_profiles;
-- this table just records which ones are on a specific trip.
--
-- Also adds date_of_birth to child_profiles so the FE can compute age-per-trip
-- from DOB + the trip's start_date, without storing derived age on the BE.

-- ----- date_of_birth on child_profiles ----------------------------------------
-- Nullable: existing rows keep their age fallback; new rows can supply DOB.
alter table public.child_profiles
  add column if not exists date_of_birth date;

-- ----- trip_members ------------------------------------------------------------
create table if not exists public.trip_members (
  trip_id    uuid not null references public.trips(id)          on delete cascade,
  profile_id uuid not null references public.child_profiles(id) on delete cascade,
  user_id    uuid not null references auth.users(id),
  added_at   timestamptz not null default now(),
  primary key (trip_id, profile_id)
);

create index if not exists trip_members_trip_id_idx    on public.trip_members (trip_id);
create index if not exists trip_members_profile_id_idx on public.trip_members (profile_id);
create index if not exists trip_members_user_id_idx    on public.trip_members (user_id);

-- ----- RLS -------------------------------------------------------------------
alter table public.trip_members enable row level security;
alter table public.trip_members force row level security;

-- Owner + admin: full access (mirrors 0003 pattern).
drop policy if exists trip_members_owner_all on public.trip_members;
create policy trip_members_owner_all on public.trip_members
  for all
  using  (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

-- A linked explorer can READ the roster rows for the family's trips (read-only;
-- mirrors the trips_explorer_read policy in 0035: user_id = app.explorer_family_owner()).
drop policy if exists trip_members_explorer_read on public.trip_members;
create policy trip_members_explorer_read on public.trip_members
  for select
  using (user_id = app.explorer_family_owner());

-- ----- Grants ----------------------------------------------------------------
grant select, insert, update, delete on public.trip_members to authenticated;

-- ----- Backfill (idempotent) -------------------------------------------------
-- Every existing trip gets all of its owner's current profiles pre-added, so
-- the behaviour for existing trips is unchanged after this migration.
insert into public.trip_members (trip_id, profile_id, user_id)
select t.id, p.id, t.user_id
from   public.trips t
join   public.child_profiles p on p.user_id = t.user_id
on conflict do nothing;
