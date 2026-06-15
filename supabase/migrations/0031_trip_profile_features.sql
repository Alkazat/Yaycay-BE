-- 0031_trip_profile_features.sql
-- Per-explorer feature toggles for a trip: which features (packing, pocket
-- money, quizzes, journal, games) each child profile sees. Every explorer's
-- age band ships sensible DEFAULTS (those live in the FE); the parent layers a
-- sparse set of OVERRIDES on top, so only deviations are stored here. One row
-- per (trip, profile).
--
-- Owner-scoped customer data: standard RLS (owner-or-admin), user_id denormalised
-- for a clean predicate, mirroring trip_progress / trip_reservations.

create table if not exists public.trip_profile_features (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid not null references public.child_profiles (id) on delete cascade,
  -- Sparse map of feature_key -> bool. Absent keys fall back to the band preset
  -- on the client, so the toggle vocabulary can evolve without a migration.
  overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, profile_id)
);
create index if not exists trip_profile_features_trip_idx
  on public.trip_profile_features (trip_id);
create index if not exists trip_profile_features_user_idx
  on public.trip_profile_features (user_id);

drop trigger if exists trip_profile_features_updated_at on public.trip_profile_features;
create trigger trip_profile_features_updated_at
  before update on public.trip_profile_features
  for each row execute function app.touch_updated_at();

-- ----- RLS: owner-or-admin, mirroring trip_progress ------------------------
alter table public.trip_profile_features enable row level security;
alter table public.trip_profile_features force row level security;

drop policy if exists trip_profile_features_owner_all on public.trip_profile_features;
create policy trip_profile_features_owner_all on public.trip_profile_features
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

grant select, insert, update, delete on public.trip_profile_features to authenticated;
