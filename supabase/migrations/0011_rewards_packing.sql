-- 0011_rewards_packing.sql
-- P4: the reward economy (stars), the packing list, and the grown-ups checklist.
--
-- All three are per-trip customer state, owner-scoped by RLS exactly like trips.
-- Stars are an append-only ledger: a claim is idempotent per child / day / source
-- (a unique key), so re-claiming the same achievement never double-counts. A
-- child's balance is the sum of their ledger rows. Packing items are simple CRUD
-- with a packed flag. The grown-ups checklist persists tick state keyed by the
-- FE's item id (the checklist content itself lives in trip_content.grownups).

-- ----- star_ledger ---------------------------------------------------------
create table if not exists public.star_ledger (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid not null references public.child_profiles (id) on delete cascade,
  -- What earned the stars, e.g. 'challenge:<id>', 'star_challenge', 'game:<id>'.
  source text not null,
  -- Per-day scoping ('' when not day-specific) so the idempotency key is stable.
  day text not null default '',
  stars int not null default 1 check (stars between 1 and 10),
  created_at timestamptz not null default now(),
  -- Idempotent per child / day / source: the same achievement claims once.
  unique (trip_id, profile_id, day, source)
);
create index if not exists star_ledger_trip_idx on public.star_ledger (trip_id);
create index if not exists star_ledger_profile_idx on public.star_ledger (profile_id);

-- ----- packing_items -------------------------------------------------------
create table if not exists public.packing_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Optional: an item can belong to a specific child or be shared (null).
  profile_id uuid references public.child_profiles (id) on delete set null,
  label text not null,
  category text,
  packed boolean not null default false,
  position int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists packing_items_trip_idx on public.packing_items (trip_id);

-- ----- grownups_checklist --------------------------------------------------
create table if not exists public.grownups_checklist (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The FE's checklist item id/label; tick state is persisted per (trip, item).
  item text not null,
  checked boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (trip_id, item)
);
create index if not exists grownups_checklist_trip_idx on public.grownups_checklist (trip_id);

-- ----- RLS -----------------------------------------------------------------
-- Owner-scoped exactly like trips: the caller reads/writes only their own rows.
do $$
declare
  t text;
begin
  foreach t in array array['star_ledger', 'packing_items', 'grownups_checklist'] loop
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
  public.star_ledger,
  public.packing_items,
  public.grownups_checklist
  to authenticated;

-- ----- updated_at triggers -------------------------------------------------
drop trigger if exists packing_items_updated_at on public.packing_items;
create trigger packing_items_updated_at
  before update on public.packing_items
  for each row execute function app.touch_updated_at();

drop trigger if exists grownups_checklist_updated_at on public.grownups_checklist;
create trigger grownups_checklist_updated_at
  before update on public.grownups_checklist
  for each row execute function app.touch_updated_at();
