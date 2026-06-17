-- trip_shares_rls_test.sql
-- Proves share links are owner-scoped: an owner sees/manages their own share;
-- another signed-in user sees none. (The public GET /shared/:token resolver
-- reads via the service role, which bypasses RLS by design.)

begin;
select plan(4);

select has_table('public', 'trip_shares', 'trip_shares table exists');
select is(relrowsecurity, true, 'RLS enabled on trip_shares')
  from pg_class where oid = 'public.trip_shares'::regclass;

-- ----- Seed: two users, one trip + share owned by the first -----------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'owner-s@example.com'),
  ('00000000-0000-0000-0000-0000000000d2', 'other-s@example.com');

insert into public.trips (id, user_id, destination)
  values ('33333333-3333-3333-3333-3333333333d1',
          '00000000-0000-0000-0000-0000000000d1', 'Singapore');

insert into public.trip_shares (token, trip_id, user_id)
  values ('tok_test_d1', '33333333-3333-3333-3333-3333333333d1',
          '00000000-0000-0000-0000-0000000000d1');

-- ----- Owner sees their share -----------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_shares), 1,
  'owner reads their own share'
);
reset role;

-- ----- A different signed-in user sees nothing ------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_shares), 0,
  'a non-owner cannot see the share'
);
reset role;

select * from finish();
rollback;
