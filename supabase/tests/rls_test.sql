-- rls_test.sql
-- Proves RLS isolation: account A can never read or write account B's rows,
-- and the admin role bypasses per-family scoping. Run with `supabase test db`.

begin;
select plan(11);

-- pgTAP is available in the Supabase test runner.
select has_table('public', 'trips', 'trips table exists');
select has_table('public', 'trip_content', 'trip_content table exists');

-- RLS must be enabled (and forced) on every customer table.
select is(relrowsecurity, true, 'RLS enabled on trips')
  from pg_class where oid = 'public.trips'::regclass;
select is(relforcerowsecurity, true, 'RLS forced on trips')
  from pg_class where oid = 'public.trip_content'::regclass;

-- ----- Seed two accounts and a trip each (service role / definer context) ---
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'admin@example.com');

-- Promote C to admin in the isolated identity store.
update identity.accounts set role = 'admin'
  where user_id = '00000000-0000-0000-0000-00000000000c';

insert into public.trips (id, user_id, destination)
values
  ('11111111-1111-1111-1111-11111111111a', '00000000-0000-0000-0000-00000000000a', 'Singapore'),
  ('11111111-1111-1111-1111-11111111111b', '00000000-0000-0000-0000-00000000000b', 'Tokyo');

-- ----- Act as account A -----------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
  true
);

select is(
  (select count(*)::int from public.trips),
  1,
  'account A sees exactly one trip (its own)'
);
select is(
  (select destination from public.trips),
  'Singapore',
  'account A sees only its own destination'
);
select is(
  (select count(*)::int from public.trips
   where id = '11111111-1111-1111-1111-11111111111b'),
  0,
  'account A cannot read account B''s trip'
);

-- A attempt to update B's trip affects zero rows (filtered by USING).
update public.trips set destination = 'Hacked'
  where id = '11111111-1111-1111-1111-11111111111b';
select is(
  (select count(*)::int from public.trips
   where destination = 'Hacked'),
  0,
  'account A cannot update account B''s trip'
);

reset role;
select is(
  (select destination from public.trips
   where id = '11111111-1111-1111-1111-11111111111b'),
  'Tokyo',
  'account B''s trip is untouched after A''s write attempt'
);

-- ----- Act as account B -----------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}',
  true
);
select is(
  (select count(*)::int from public.trips),
  1,
  'account B sees exactly one trip (its own)'
);
reset role;

-- ----- Act as admin ---------------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}',
  true
);
select is(
  (select count(*)::int from public.trips),
  2,
  'admin bypasses per-family scoping and sees all trips'
);
reset role;

select * from finish();
rollback;
