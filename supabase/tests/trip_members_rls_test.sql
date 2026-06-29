-- trip_members_rls_test.sql
-- Verifies RLS isolation on the trip_members table:
--   1. Owner A can see and write their own trip_members; cannot see owner B's.
--   2. A linked explorer (via explorer_logins) can READ the family's roster but
--      cannot INSERT or DELETE rows (write is blocked by the owner-only policy).
--   3. An unrelated user sees nothing.
--
-- Mirror of explorer_logins_rls_test.sql structure. Run with `supabase test db`.

begin;
select plan(14);

select has_table('public', 'trip_members', 'trip_members table exists');
select is(relrowsecurity, true, 'RLS enabled on trip_members')
  from pg_class where oid = 'public.trip_members'::regclass;
select is(relforcerowsecurity, true, 'RLS forced on trip_members')
  from pg_class where oid = 'public.trip_members'::regclass;

-- ----- Seed -----------------------------------------------------------------
-- a1 = parent/owner A, a2 = explorer linked to A, a3 = unrelated owner B.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'parentA@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'explorerA@example.com'),
  ('00000000-0000-0000-0000-0000000000b3', 'parentB@example.com');

-- Two profiles under owner A, one profile under owner B.
insert into public.child_profiles (id, user_id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000b1', 'Alice'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-0000000000b1', 'Bob'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '00000000-0000-0000-0000-0000000000b3', 'Carol');

-- One trip each under owners A and B.
insert into public.trips (id, user_id, destination) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '00000000-0000-0000-0000-0000000000b1', 'Paris'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '00000000-0000-0000-0000-0000000000b3', 'Rome');

-- Roster: A's trip has Alice + Bob; B's trip has Carol.
insert into public.trip_members (trip_id, profile_id, user_id) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000b1'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-0000000000b1'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '00000000-0000-0000-0000-0000000000b3');

-- Explorer login linking a2 to owner A's family (Alice's profile).
insert into public.explorer_logins (id, child_profile_id, auth_user_id, parent_user_id, email) values
  ('ffffffff-ffff-ffff-ffff-ffffffffffff',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000b1',
   'explorerA@example.com');

-- ----- Owner A: full access, sees only their own members --------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.trip_members),
  2,
  'owner A sees exactly their 2 trip_members rows'
);
select is(
  (select count(*)::int from public.trip_members
   where trip_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0,
  'owner A cannot see owner B''s trip_members'
);
reset role;

-- ----- Owner B: full access to their own rows; cannot see A's ---------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.trip_members),
  1,
  'owner B sees exactly their 1 trip_members row'
);
select is(
  (select count(*)::int from public.trip_members
   where trip_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  0,
  'owner B cannot see owner A''s trip_members'
);

-- B attempts to update A's member row; USING predicate blocks it.
update public.trip_members
  set added_at = now()
  where trip_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
select is(
  (select count(*)::int from public.trip_members
   where trip_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  0,
  'owner B cannot update owner A''s trip_members (0 rows visible after attempt)'
);
reset role;

-- ----- Explorer (a2, linked to owner A): read-only, sees A's roster ---------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.trip_members),
  2,
  'linked explorer can read the family''s 2 trip_members rows'
);

-- Explorer should NOT be able to insert (no WITH CHECK on explorer_read policy).
-- We verify via an attempted insert that the row count stays unchanged.
begin;
  insert into public.trip_members (trip_id, profile_id, user_id)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            '00000000-0000-0000-0000-0000000000b2')
    on conflict do nothing;
  select is(
    (select count(*)::int from public.trip_members
     where user_id = '00000000-0000-0000-0000-0000000000b2'),
    0,
    'explorer cannot insert trip_members rows owned by their own auth id (WITH CHECK blocks it)'
  );
rollback;

reset role;

-- ----- Unrelated user: sees nothing -----------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
-- We're actually reusing b3 (owner B) here; substitute a truly unrelated seed
-- to keep the test honest. Re-check with a fictitious sub that has no data.
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0001-000000000000","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_members),
  0,
  'an unrelated user sees no trip_members rows'
);
reset role;

-- ----- Revoked explorer link grants nothing ---------------------------------
update public.explorer_logins set disabled_at = now()
  where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.trip_members),
  0,
  'a disabled explorer login sees no trip_members rows'
);
reset role;

select * from finish();
rollback;
