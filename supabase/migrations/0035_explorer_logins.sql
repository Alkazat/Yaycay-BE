-- 0035_explorer_logins.sql
-- Optional per-explorer logins. A child_profile can be linked to its OWN
-- auth.users account (a real magic-link login) so an explorer can sign in and
-- explore the family's trips themselves. The owning parent account still owns
-- every row; a linked explorer gets READ-ONLY visibility of the family's trips
-- and their own profile, scoped through the link. No link => the explorer simply
-- uses the parent account + profile switch (the fallback). Writes to this table
-- are service-role only (provisioning mints the auth.users out-of-band).

create table if not exists public.explorer_logins (
  id uuid primary key default gen_random_uuid(),
  -- The profile this login belongs to.
  child_profile_id uuid not null references public.child_profiles (id) on delete cascade,
  -- The explorer's own auth.users account (distinct from the parent's).
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  -- The family/owner account that owns the underlying data (for access checks).
  parent_user_id uuid not null references auth.users (id) on delete cascade,
  -- The email the magic-link login was provisioned for (stored lower-cased).
  email text not null,
  invited_at timestamptz not null default now(),
  -- Soft revoke: a disabled link grants nothing (RLS checks disabled_at is null).
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE login per profile; one auth user maps to one profile.
create unique index if not exists explorer_logins_one_active_per_profile
  on public.explorer_logins (child_profile_id) where disabled_at is null;
create unique index if not exists explorer_logins_auth_user_key
  on public.explorer_logins (auth_user_id);
create index if not exists explorer_logins_parent_idx
  on public.explorer_logins (parent_user_id);

drop trigger if exists explorer_logins_updated_at on public.explorer_logins;
create trigger explorer_logins_updated_at
  before update on public.explorer_logins
  for each row execute function app.touch_updated_at();

-- ----- Helpers --------------------------------------------------------------
-- Definer functions so an RLS predicate can consult the link table without the
-- caller needing to read it (and without recursing into the policies below).

-- The profile the current auth user is an ACTIVE explorer for (or null).
create or replace function app.explorer_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.child_profile_id
  from public.explorer_logins l
  where l.auth_user_id = auth.uid() and l.disabled_at is null
  limit 1;
$$;

-- The family owner (parent) the current auth user may explore (or null).
create or replace function app.explorer_family_owner()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.parent_user_id
  from public.explorer_logins l
  where l.auth_user_id = auth.uid() and l.disabled_at is null
  limit 1;
$$;

-- ----- RLS: explorer_logins -------------------------------------------------
alter table public.explorer_logins enable row level security;
alter table public.explorer_logins force row level security;

-- The parent reads their family's links; an explorer reads their own. All WRITES
-- are service-role only (provisioning mints the auth.users), so no client
-- insert/update/delete policy is granted.
drop policy if exists explorer_logins_read on public.explorer_logins;
create policy explorer_logins_read on public.explorer_logins
  for select
  using (parent_user_id = auth.uid() or auth_user_id = auth.uid() or app.is_admin());

-- ----- RLS: extend read access for linked explorers -------------------------
-- Permissive SELECT policies OR-combine with the existing owner_all policies, so
-- a parent keeps full access and a linked explorer additionally gets read-only
-- visibility of just their slice.

-- An explorer sees ONLY their own profile row.
drop policy if exists child_profiles_explorer_self on public.child_profiles;
create policy child_profiles_explorer_self on public.child_profiles
  for select
  using (id = app.explorer_profile_id());

-- An explorer can READ the family's trips + content (read-only exploration).
drop policy if exists trips_explorer_read on public.trips;
create policy trips_explorer_read on public.trips
  for select
  using (user_id = app.explorer_family_owner());

drop policy if exists trip_content_explorer_read on public.trip_content;
create policy trip_content_explorer_read on public.trip_content
  for select
  using (user_id = app.explorer_family_owner());

-- An explorer can READ their own progress row (per profile).
drop policy if exists trip_progress_explorer_self on public.trip_progress;
create policy trip_progress_explorer_self on public.trip_progress
  for select
  using (profile_id = app.explorer_profile_id());

-- ----- grants ---------------------------------------------------------------
grant execute on function app.explorer_profile_id() to authenticated, anon;
grant execute on function app.explorer_family_owner() to authenticated, anon;
grant select on public.explorer_logins to authenticated;
