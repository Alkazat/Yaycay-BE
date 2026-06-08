-- 0003_rls.sql
-- Row-Level Security is mandatory on every table that holds customer data.
-- A row is readable/writable only by its owning account (user_id = auth.uid()),
-- except for the admin role, which bypasses per-family scoping.
-- RLS is proven by pgTAP (supabase/tests): account A can never read account B.

-- ----- child_profiles ------------------------------------------------------
alter table public.child_profiles enable row level security;
alter table public.child_profiles force row level security;

drop policy if exists child_profiles_owner_all on public.child_profiles;
create policy child_profiles_owner_all on public.child_profiles
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

-- ----- trips ---------------------------------------------------------------
alter table public.trips enable row level security;
alter table public.trips force row level security;

drop policy if exists trips_owner_all on public.trips;
create policy trips_owner_all on public.trips
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

-- ----- trip_content --------------------------------------------------------
alter table public.trip_content enable row level security;
alter table public.trip_content force row level security;

drop policy if exists trip_content_owner_all on public.trip_content;
create policy trip_content_owner_all on public.trip_content
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

-- ----- trip_progress -------------------------------------------------------
alter table public.trip_progress enable row level security;
alter table public.trip_progress force row level security;

drop policy if exists trip_progress_owner_all on public.trip_progress;
create policy trip_progress_owner_all on public.trip_progress
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

-- ----- ai_jobs -------------------------------------------------------------
-- Owners read their own job log; writes are made by the service role / definer
-- paths only, so no owner write policy is granted.
alter table public.ai_jobs enable row level security;
alter table public.ai_jobs force row level security;

drop policy if exists ai_jobs_owner_select on public.ai_jobs;
create policy ai_jobs_owner_select on public.ai_jobs
  for select
  using (user_id = auth.uid() or app.is_admin());

-- ----- marketing_contacts --------------------------------------------------
-- Lead capture is a public/service-role write path (no auth user yet), so we do
-- not expose it to the authenticated client role. Admins may read.
alter table public.marketing_contacts enable row level security;
alter table public.marketing_contacts force row level security;

drop policy if exists marketing_contacts_admin_select on public.marketing_contacts;
create policy marketing_contacts_admin_select on public.marketing_contacts
  for select
  using (app.is_admin());

-- ----- grants --------------------------------------------------------------
-- PostgREST uses the `authenticated` role; RLS above constrains every row.
grant usage on schema app to authenticated, anon;
grant execute on function app.is_admin() to authenticated, anon;

grant select, insert, update, delete on
  public.child_profiles,
  public.trips,
  public.trip_content,
  public.trip_progress
  to authenticated;

grant select on public.ai_jobs to authenticated;
grant select on public.marketing_contacts to authenticated;
