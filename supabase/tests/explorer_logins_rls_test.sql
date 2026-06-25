-- explorer_logins_rls_test.sql
-- Proves per-explorer logins: a linked explorer gets READ-ONLY visibility of
-- their OWN profile + the family's trips, sees nothing of other profiles, and a
-- revoked (disabled) link grants nothing. The parent keeps full access; an
-- unrelated user sees none of it.

begin;
select plan(12);

select has_table('public', 'explorer_logins', 'explorer_logins table exists');
select is(relrowsecurity, true, 'RLS enabled on explorer_logins')
  from pg_class where oid = 'public.explorer_logins'::regclass;

-- ----- Seed -----------------------------------------------------------------
-- a1 = parent/owner, a2 = the explorer's own auth account, a3 = unrelated user.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'parent@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'explorer@example.com'),
  ('00000000-0000-0000-0000-0000000000a3', 'stranger@example.com');

-- Two children under the parent; the explorer login is for Pip only.
insert into public.child_profiles (id, user_id, name) values
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', 'Pip'),
  ('11111111-1111-1111-1111-1111111111a2', '00000000-0000-0000-0000-0000000000a1', 'Sib');

insert into public.trips (id, user_id, destination) values
  ('22222222-2222-2222-2222-2222222222a1', '00000000-0000-0000-0000-0000000000a1', 'Singapore');
insert into public.trip_content (trip_id, user_id) values
  ('22222222-2222-2222-2222-2222222222a1', '00000000-0000-0000-0000-0000000000a1');
insert into public.trip_progress (id, trip_id, user_id, profile_id) values
  ('33333333-3333-3333-3333-3333333333a1', '22222222-2222-2222-2222-2222222222a1',
   '00000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-1111111111a1');

insert into public.explorer_logins (id, child_profile_id, auth_user_id, parent_user_id, email)
  values ('44444444-4444-4444-4444-4444444444a1',
          '11111111-1111-1111-1111-1111111111a1',
          '00000000-0000-0000-0000-0000000000a2',
          '00000000-0000-0000-0000-0000000000a1', 'explorer@example.com');

-- ----- Parent: full access, sees the link -----------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.explorer_logins), 1,
  'parent sees the explorer login link');
select is((select count(*)::int from public.child_profiles), 2,
  'parent sees both of their profiles');
reset role;

-- ----- Explorer: read-only slice of just their own ---------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
select is((select count(*)::int from public.child_profiles), 1,
  'explorer sees only their own profile');
select is((select name from public.child_profiles), 'Pip',
  'the profile the explorer sees is their own');
select is((select count(*)::int from public.trips), 1,
  'explorer can read the family trip');
select is((select count(*)::int from public.trip_progress), 1,
  'explorer can read their own progress row');
select is((select count(*)::int from public.explorer_logins), 1,
  'explorer can read their own link');
reset role;

-- ----- Stranger: nothing ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
select is((select count(*)::int from public.trips), 0,
  'an unrelated user sees no family trips');
reset role;

-- ----- Revoked link grants nothing ------------------------------------------
update public.explorer_logins set disabled_at = now()
  where id = '44444444-4444-4444-4444-4444444444a1';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
select is((select count(*)::int from public.child_profiles), 0,
  'a disabled login sees no profile');
select is((select count(*)::int from public.trips), 0,
  'a disabled login sees no trips');
reset role;

select * from finish();
rollback;
