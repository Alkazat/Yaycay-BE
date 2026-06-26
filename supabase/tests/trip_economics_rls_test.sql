-- trip_economics_rls_test.sql
-- Proves the four economics containers (per-child challenges, budget, costs,
-- reward config) are owner-scoped: an owner sees their own rows; another
-- signed-in user sees none.

begin;
select plan(16);

-- ----- tables exist + RLS enabled ------------------------------------------
select has_table('public', 'trip_profile_challenges', 'trip_profile_challenges exists');
select has_table('public', 'trip_budget', 'trip_budget exists');
select has_table('public', 'trip_costs', 'trip_costs exists');
select has_table('public', 'trip_reward_config', 'trip_reward_config exists');

select is(relrowsecurity, true, 'RLS on trip_profile_challenges')
  from pg_class where oid = 'public.trip_profile_challenges'::regclass;
select is(relrowsecurity, true, 'RLS on trip_budget')
  from pg_class where oid = 'public.trip_budget'::regclass;
select is(relrowsecurity, true, 'RLS on trip_costs')
  from pg_class where oid = 'public.trip_costs'::regclass;
select is(relrowsecurity, true, 'RLS on trip_reward_config')
  from pg_class where oid = 'public.trip_reward_config'::regclass;

-- ----- Seed: two users, one trip + child profile owned by the first ---------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner-e@example.com'),
  ('00000000-0000-0000-0000-0000000000e2', 'other-e@example.com');

insert into public.trips (id, user_id, destination)
  values ('44444444-4444-4444-4444-4444444444e1',
          '00000000-0000-0000-0000-0000000000e1', 'Singapore');

insert into public.child_profiles (id, user_id, name, type)
  values ('44444444-4444-4444-4444-4444444444e9',
          '00000000-0000-0000-0000-0000000000e1', 'Tay', 'child');

insert into public.trip_profile_challenges (trip_id, user_id, profile_id, day, prompt)
  values ('44444444-4444-4444-4444-4444444444e1', '00000000-0000-0000-0000-0000000000e1',
          '44444444-4444-4444-4444-4444444444e9', 'd2', 'Half-lion, half-fish statue?');
insert into public.trip_budget (trip_id, user_id, exchange_rate, cash_budget)
  values ('44444444-4444-4444-4444-4444444444e1', '00000000-0000-0000-0000-0000000000e1', 1.12, 200);
insert into public.trip_costs (trip_id, user_id, label, amount_base)
  values ('44444444-4444-4444-4444-4444444444e1', '00000000-0000-0000-0000-0000000000e1', 'Universal Studios', 88);
insert into public.trip_reward_config (trip_id, user_id, star_value)
  values ('44444444-4444-4444-4444-4444444444e1', '00000000-0000-0000-0000-0000000000e1', 3);

-- ----- Owner sees their rows ------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
select is((select count(*)::int from public.trip_profile_challenges), 1, 'owner reads own challenge');
select is((select count(*)::int from public.trip_budget), 1, 'owner reads own budget');
select is((select count(*)::int from public.trip_costs), 1, 'owner reads own cost');
select is((select count(*)::int from public.trip_reward_config), 1, 'owner reads own reward config');
reset role;

-- ----- A different signed-in user sees nothing ------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
select is((select count(*)::int from public.trip_profile_challenges), 0, 'non-owner sees no challenge');
select is((select count(*)::int from public.trip_budget), 0, 'non-owner sees no budget');
select is((select count(*)::int from public.trip_costs), 0, 'non-owner sees no cost');
select is((select count(*)::int from public.trip_reward_config), 0, 'non-owner sees no reward config');
reset role;

select * from finish();
rollback;
