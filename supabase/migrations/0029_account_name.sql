-- 0024_account_name.sql
-- Optional account display name (Settings -> Name editor). Not collected at
-- sign-up; set later. Nullable. service_role already holds select+update on
-- identity.accounts (0004), so no new grant is needed.

alter table identity.accounts
  add column if not exists name text;
