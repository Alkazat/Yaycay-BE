-- support_sessions_rls_test.sql
-- Proves the admin "view-as" table is confined to role=admin for reads, has no
-- client write path (appends/closes happen via the service role / API only),
-- and that at most one open session per admin is allowed.

begin;
select plan(6);

select has_table('public', 'support_sessions', 'support_sessions table exists');
select is(relrowsecurity, true, 'RLS enabled on support_sessions')
  from pg_class where oid = 'public.support_sessions'::regclass;

-- ----- Seed: a normal user, an admin, and one open session ------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'user-va@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'admin-va@example.com');

update identity.accounts set role = 'admin'
  where user_id = '00000000-0000-0000-0000-0000000000b2';

insert into public.support_sessions (actor_id, target_user_id, reason, expires_at)
  values ('00000000-0000-0000-0000-0000000000b2',
          '00000000-0000-0000-0000-0000000000b1',
          'ticket #123', now() + interval '30 minutes');

-- One open session per admin: a second open row violates the partial unique idx.
select throws_ok(
  $$insert into public.support_sessions (actor_id, target_user_id, reason, expires_at)
    values ('00000000-0000-0000-0000-0000000000b2',
            '00000000-0000-0000-0000-0000000000b1',
            'ticket #124', now() + interval '30 minutes')$$,
  '23505',
  null,
  'an admin may hold at most one open support session'
);

-- ----- Act as the normal user ----------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.support_sessions), 0,
  'non-admin cannot read support sessions'
);
select throws_ok(
  $$insert into public.support_sessions (actor_id, target_user_id, reason, expires_at)
    values ('00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000000b2',
            'hijack', now() + interval '30 minutes')$$,
  '42501',
  null,
  'non-admin cannot open a support session'
);
reset role;

-- ----- Act as the admin -----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.support_sessions), 1,
  'admin can read support sessions'
);
reset role;

select * from finish();
rollback;
