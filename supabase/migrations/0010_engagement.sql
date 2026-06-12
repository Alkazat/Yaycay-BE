-- 0010_engagement.sql
-- The engagement surfaces behind the FE reward loop: a star ledger (earn/claim),
-- packing lists (per child + family), and journal mood. All owner-scoped via RLS.

-- ----- star_ledger ---------------------------------------------------------
-- Append-only deltas; a profile's balance is the sum of its deltas. Earning is
-- a positive delta (challenge/game/star_challenge), claiming is negative.
create table if not exists public.star_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  profile_id uuid references public.child_profiles (id) on delete cascade,
  delta integer not null,
  reason text,
  -- challenge | game | star_challenge | manual | claim
  source text,
  ref_id text,
  created_at timestamptz not null default now()
);
create index if not exists star_ledger_trip_profile_idx
  on public.star_ledger (trip_id, profile_id);
create index if not exists star_ledger_user_idx on public.star_ledger (user_id);

-- ----- packing_items -------------------------------------------------------
create table if not exists public.packing_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  -- null profile_id = the shared family list.
  profile_id uuid references public.child_profiles (id) on delete cascade,
  section text not null default 'General',
  label text not null,
  packed boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists packing_items_trip_idx on public.packing_items (trip_id);
create index if not exists packing_items_user_idx on public.packing_items (user_id);

-- ----- journal mood --------------------------------------------------------
alter table public.journal_entries add column if not exists mood text;
alter table public.journal_entries add column if not exists stars integer;

-- ----- RLS -----------------------------------------------------------------
alter table public.star_ledger enable row level security;
alter table public.star_ledger force row level security;
drop policy if exists star_ledger_owner_all on public.star_ledger;
create policy star_ledger_owner_all on public.star_ledger
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid());

alter table public.packing_items enable row level security;
alter table public.packing_items force row level security;
drop policy if exists packing_items_owner_all on public.packing_items;
create policy packing_items_owner_all on public.packing_items
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.star_ledger to authenticated;
grant select, insert, update, delete on public.packing_items to authenticated;

-- updated_at trigger for packing_items
drop trigger if exists packing_items_updated_at on public.packing_items;
create trigger packing_items_updated_at
  before update on public.packing_items
  for each row execute function app.touch_updated_at();
