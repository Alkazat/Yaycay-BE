-- 0036_trip_economics.sql
-- First-class containers for trip data the canonical content blob cannot hold:
-- per-child challenges, money (budget + costs), and the reward economy config.
--
-- The trip_content JSON is closed (additionalProperties:false) and holds exactly
-- one challenge per activity / one star_challenge per day - it cannot express a
-- DIFFERENT challenge per child, nor quantitative money. These four tables are
-- per-trip customer state, owner-scoped by RLS exactly like trips/trip_intent,
-- with user_id denormalised for a clean predicate.
--
-- Content nodes (days/activities) are referenced by their STRING id (day text
-- e.g. 'd2', node_ref text e.g. 'a1') - never an FK, since content ids are not
-- DB rows. This mirrors star_ledger.day / star_ledger.source.

-- ----- trip_profile_challenges ---------------------------------------------
-- A challenge tailored to one child for one day/activity (e.g. Tay age 9 and
-- Savy age 13 get different quizzes on the same day). Awards still flow to
-- star_ledger with source = 'profile_challenge:<id>'.
create table if not exists public.trip_profile_challenges (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid not null references public.child_profiles (id) on delete cascade,
  -- Which content node this challenge attaches to (by string id).
  day text not null,
  -- '' = day-level; otherwise an activity id e.g. 'a1'.
  node_ref text not null default '',
  kind text not null default 'quiz'
    check (kind in ('quiz', 'spot', 'photo', 'challenge')),
  prompt text not null,
  answer text,
  options text[] not null default '{}',
  stars int not null default 1 check (stars between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One challenge per child / day / node: re-seeding upserts, never duplicates.
  unique (trip_id, profile_id, day, node_ref)
);
create index if not exists trip_profile_challenges_trip_idx on public.trip_profile_challenges (trip_id);
create index if not exists trip_profile_challenges_profile_idx on public.trip_profile_challenges (profile_id);

-- ----- trip_budget ---------------------------------------------------------
-- One row per trip: the cash envelope and the point-in-time exchange rate.
create table if not exists public.trip_budget (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  base_currency text not null default 'SGD' check (base_currency ~ '^[A-Z]{3}$'),
  home_currency text not null default 'AUD' check (home_currency ~ '^[A-Z]{3}$'),
  -- 1 base = exchange_rate home (e.g. 1 SGD = 1.12 AUD).
  exchange_rate numeric(12, 6),
  rate_as_of date,
  cash_budget numeric(12, 2),
  daily_cash_budget numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trip_budget_user_idx on public.trip_budget (user_id);

-- ----- trip_costs ----------------------------------------------------------
-- Many rows per trip: a line-item cost, optionally tied to a tracked booking
-- and/or a content node. Both currencies are stored (not derived) so a later
-- rate change never silently rewrites history. Money is numeric, never float.
create table if not exists public.trip_costs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reservation_id uuid references public.trip_reservations (id) on delete set null,
  day text not null default '',
  node_ref text not null default '',
  label text not null,
  amount_base numeric(12, 2),
  amount_home numeric(12, 2),
  currency_base text not null default 'SGD' check (currency_base ~ '^[A-Z]{3}$'),
  currency_home text not null default 'AUD' check (currency_home ~ '^[A-Z]{3}$'),
  paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotent per trip / day / node / label.
  unique (trip_id, day, node_ref, label)
);
create index if not exists trip_costs_trip_idx on public.trip_costs (trip_id);
create index if not exists trip_costs_reservation_idx on public.trip_costs (reservation_id);

-- ----- trip_reward_config --------------------------------------------------
-- The star economy: 1 star = star_value, plus optional per-child targets. A row
-- with profile_id IS NULL is the trip default; a row with profile_id overrides
-- it for that child. Balances stay in star_ledger; cash value = balance * the
-- resolved star_value (child override else default).
create table if not exists public.trip_reward_config (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid references public.child_profiles (id) on delete cascade,
  star_value numeric(10, 2),
  currency text not null default 'SGD' check (currency ~ '^[A-Z]{3}$'),
  star_target int check (star_target is null or star_target >= 0),
  star_budget numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Exactly one default row per trip, and at most one override per child
-- (partial-unique pattern, as in explorer_logins).
create unique index if not exists trip_reward_config_default_key
  on public.trip_reward_config (trip_id) where profile_id is null;
create unique index if not exists trip_reward_config_child_key
  on public.trip_reward_config (trip_id, profile_id) where profile_id is not null;
create index if not exists trip_reward_config_user_idx on public.trip_reward_config (user_id);

-- ----- RLS: owner-or-admin, mirroring trip_reservations / star_ledger ------
do $$
declare
  t text;
begin
  foreach t in array array[
    'trip_profile_challenges', 'trip_budget', 'trip_costs', 'trip_reward_config'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists %I_owner_all on public.%I;', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all using (user_id = auth.uid() or app.is_admin()) with check (user_id = auth.uid());',
      t, t
    );
  end loop;
end $$;

grant select, insert, update, delete on
  public.trip_profile_challenges,
  public.trip_budget,
  public.trip_costs,
  public.trip_reward_config
  to authenticated;

-- ----- updated_at triggers -------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'trip_profile_challenges', 'trip_budget', 'trip_costs', 'trip_reward_config'
  ] loop
    execute format('drop trigger if exists %I_updated_at on public.%I;', t, t);
    execute format(
      'create trigger %I_updated_at before update on public.%I for each row execute function app.touch_updated_at();',
      t, t
    );
  end loop;
end $$;
