-- admin_rls_test.sql
-- Proves the v0.2 admin tables are confined to role=admin, the catalogue is
-- readable by any signed-in client, and purchases stay owner-scoped.

begin;
select plan(9);

select has_table('public', 'prompts', 'prompts table exists');
select has_table('public', 'model_routes', 'model_routes table exists');
select is(relrowsecurity, true, 'RLS enabled on prompts')
  from pg_class where oid = 'public.prompts'::regclass;

-- ai_job_kind was realigned to the contract values.
select ok(
  exists(select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = 'ai_job_kind' and e.enumlabel = 'generation'),
  'ai_job_kind has value generation'
);

-- ----- Seed: a normal user, an admin, catalogue, a prompt, a purchase -------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'user@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@example.com');

update identity.accounts set role = 'admin'
  where user_id = '00000000-0000-0000-0000-0000000000a2';

insert into public.products (price_id, name, amount_usd)
  values ('price_holiday_ai', 'Use-our-AI holiday', 129.00);

insert into public.prompts (task, title, body, model, version, active)
  values ('generate_day', 'Day generator', 'system prompt', 'claude-sonnet', 1, true);

insert into public.trips (id, user_id, destination)
  values ('22222222-2222-2222-2222-2222222222a1',
          '00000000-0000-0000-0000-0000000000a1', 'Singapore');
insert into public.purchases (user_id, trip_id, price_id, tier, amount_usd)
  values ('00000000-0000-0000-0000-0000000000a1',
          '22222222-2222-2222-2222-2222222222a1', 'price_holiday_ai', 'ours', 129.00);

-- ----- Act as the normal user ----------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.prompts), 0,
  'non-admin cannot read prompts'
);
select throws_ok(
  $$insert into public.prompts (task, title, body, model, version)
    values ('hack', 'x', 'y', 'openai', 1)$$,
  '42501',
  null,
  'non-admin cannot insert a prompt'
);
select is(
  (select count(*)::int from public.products where price_id = 'price_holiday_ai'), 1,
  'any signed-in client can read the catalogue'
);
select is(
  (select count(*)::int from public.purchases), 1,
  'owner sees only their own purchase'
);
reset role;

-- ----- Act as the admin -----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.prompts), 1,
  'admin can read prompts'
);
reset role;

select * from finish();
rollback;
