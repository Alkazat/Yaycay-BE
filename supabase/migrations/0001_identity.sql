-- 0001_identity.sql
-- Isolated identity store. In production this is a dedicated Supabase project;
-- locally we model it as a locked-down `identity` schema with stricter grants.
-- Everything else lives in the app schema and joins by user_id only.

create schema if not exists identity;

-- Account roles. `user` is locked to its own rows; `admin` bypasses per-family
-- scoping (Admin app, MFA-gated).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'account_role') then
    create type identity.account_role as enum ('user', 'admin');
  end if;
end
$$;

create table if not exists identity.accounts (
  -- The account is the parent (owner). Keyed to the auth user.
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  -- Password reset requires a secondary email (see 00-MODEL-CONTEXT.md sec 6).
  recovery_email text,
  role identity.account_role not null default 'user',
  -- 2FA is mandatory for admin; tracked here, enforced in the auth flow.
  two_factor_enrolled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists accounts_email_key on identity.accounts (lower(email));

-- Lock the schema down: no access for the anon/authenticated client roles.
-- Reads go through SECURITY DEFINER helpers (see 0003_rls.sql) or the service role.
revoke all on schema identity from anon, authenticated;
revoke all on all tables in schema identity from anon, authenticated;

-- Keep `updated_at` honest.
create or replace function identity.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists accounts_touch_updated_at on identity.accounts;
create trigger accounts_touch_updated_at
  before update on identity.accounts
  for each row execute function identity.touch_updated_at();

-- Provision an account row whenever a new auth user is created.
create or replace function identity.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = identity
as $$
begin
  insert into identity.accounts (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function identity.handle_new_user();
