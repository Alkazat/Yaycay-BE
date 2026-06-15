-- trip_reservations_rls_test.sql
-- Proves the family's booking record is owner-scoped: an owner sees their own
-- reservations; another signed-in user sees none.

begin;
select plan(4);

select has_table('public', 'trip_reservations', 'trip_reservations table exists');
select is(relrowsecurity, true, 'RLS enabled on trip_reservations')
  from pg_class where oid = 'public.trip_reservations'::regclass;

-- ----- Seed: two users, one trip + reservation owned by the first -----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-r@example.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'other-r@example.com');

insert into public.trips (id, user_id, destination)
  values ('33333333-3333-3333-3333-3333333333c1',
          '00000000-0000-0000-0000-0000000000c1', 'Gold Coast');

insert into public.trip_reservations (trip_id, user_id, title, kind, status)
  values ('33333333-3333-3333-3333-3333333333c1',
          '00000000-0000-0000-0000-0000000000c1', 'Sea World tickets', 'activity', 'booked');

-- ----- Owner sees their reservation -----------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_reservations), 1,
  'owner reads their own reservation'
);
reset role;

-- ----- A different signed-in user sees nothing ------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_reservations), 0,
  'a non-owner cannot see the reservation'
);
reset role;

select * from finish();
rollback;
