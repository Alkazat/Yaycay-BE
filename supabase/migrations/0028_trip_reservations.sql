-- 0028_trip_reservations.sql
-- Track-and-confirm reservations for the "plan -> book -> confirm -> refine"
-- loop. The family (or their BYO-AI via the connector) records the bookings they
-- make elsewhere - hotel, activity, flight, transport, dining - and moves each
-- through planned -> booked -> confirmed. This is NOT a payment/booking gateway;
-- it is the family's own running record, woven into the trip.
--
-- Owner-scoped customer data: standard RLS (owner-or-admin), user_id denormalised
-- for a clean predicate, exactly as trip_intent / trip_content do.

create table if not exists public.trip_reservations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'activity'
    check (kind in ('hotel', 'activity', 'flight', 'transport', 'dining', 'other')),
  title text not null,
  -- Free-text when, as the family wrote it (e.g. "Fri 2pm", "day 3 evening").
  when_text text,
  location text,
  -- Confirmation / booking reference from wherever they booked.
  ref text,
  status text not null default 'planned'
    check (status in ('planned', 'booked', 'confirmed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trip_reservations_trip_idx on public.trip_reservations (trip_id);
create index if not exists trip_reservations_user_idx on public.trip_reservations (user_id);

drop trigger if exists trip_reservations_updated_at on public.trip_reservations;
create trigger trip_reservations_updated_at
  before update on public.trip_reservations
  for each row execute function app.touch_updated_at();

-- ----- RLS: owner-or-admin, mirroring trip_intent --------------------------
alter table public.trip_reservations enable row level security;
alter table public.trip_reservations force row level security;

drop policy if exists trip_reservations_owner_all on public.trip_reservations;
create policy trip_reservations_owner_all on public.trip_reservations
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

grant select, insert, update, delete on public.trip_reservations to authenticated;
