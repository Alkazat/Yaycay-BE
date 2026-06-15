-- trip_profile_features_rls_test.sql
-- Proves the per-explorer feature toggles are owner-scoped: an owner sees their
-- own row; another signed-in user sees none.

begin;
select plan(4);

select has_table('public', 'trip_profile_features', 'trip_profile_features table exists');
select is(relrowsecurity, true, 'RLS enabled on trip_profile_features')
  from pg_class where oid = 'public.trip_profile_features'::regclass;

-- ----- Seed: two users, one trip + child + feature row owned by the first ----
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner-f@example.com'),
  ('00000000-0000-0000-0000-0000000000f2', 'other-f@example.com');

insert into public.trips (id, user_id, destination)
  values ('44444444-4444-4444-4444-4444444444f1',
          '00000000-0000-0000-0000-0000000000f1', 'Gold Coast');

insert into public.child_profiles (id, user_id, name)
  values ('55555555-5555-5555-5555-5555555555f1',
          '00000000-0000-0000-0000-0000000000f1', 'Pip');

insert into public.trip_profile_features (trip_id, user_id, profile_id, overrides)
  values ('44444444-4444-4444-4444-4444444444f1',
          '00000000-0000-0000-0000-0000000000f1',
          '55555555-5555-5555-5555-5555555555f1',
          '{"quizzes": true}'::jsonb);

-- ----- Owner sees their feature row -----------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_profile_features), 1,
  'owner reads their own feature toggles'
);
reset role;

-- ----- A different signed-in user sees nothing ------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_profile_features), 0,
  'a non-owner cannot see the feature toggles'
);
reset role;

select * from finish();
rollback;
