-- 0012_packing_document.sql
-- Repoint packing at a per-trip document model. The FE owns a single
-- PATCH /trips/:id/packing (tick|add|delete|reset); every mutation returns the
-- whole { lists } collection so the client never merges or refetches. A jsonb
-- document per trip makes returning the recomputed collection trivial. This
-- replaces the row-per-item table from 0011, which no consumer was wired to.

drop table if exists public.packing_items;

create table if not exists public.trip_packing (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The full PackingList[] document: lists (family + per child) -> sections -> items.
  lists jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists trip_packing_user_idx on public.trip_packing (user_id);

alter table public.trip_packing enable row level security;
alter table public.trip_packing force row level security;
drop policy if exists trip_packing_owner_all on public.trip_packing;
create policy trip_packing_owner_all on public.trip_packing
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.trip_packing to authenticated;

drop trigger if exists trip_packing_updated_at on public.trip_packing;
create trigger trip_packing_updated_at
  before update on public.trip_packing
  for each row execute function app.touch_updated_at();
