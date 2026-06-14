-- 0020_demo_account_flag.sql
-- Mark seeded/demo accounts (e.g. the marketing "Walker family") so they can be
-- excluded from analytics, billing, marketing sends and any data-cleanup jobs.
-- Retention-based disposal already skips trips with a NULL retention date, which
-- the demo seed relies on; this flag makes the intent explicit and queryable.

alter table identity.accounts
  add column if not exists is_demo boolean not null default false;

create index if not exists accounts_is_demo_idx on identity.accounts (is_demo)
  where is_demo;
