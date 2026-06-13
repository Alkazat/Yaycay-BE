-- 0014_bootstrap_admin.sql
-- Bootstrap the founding admin. identity.accounts.role defaults to 'user' (0001),
-- so the first admin must be promoted once. Idempotent and environment-safe: it
-- promotes the account for the founder email only if that auth user exists, so it
-- no-ops on environments where they have not signed up (e.g. staging). Manage
-- additional admins via SQL/an admin flow; this just unblocks the first one.
insert into identity.accounts (user_id, email, role)
select id, email, 'admin'
  from auth.users
 where lower(email) = lower('dyeates@dwhy.com.au')
on conflict (user_id) do update set role = 'admin';
