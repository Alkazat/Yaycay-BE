-- 0023_trip_intent.sql
-- First-class trip intent: the "why" behind a trip, captured once and shared by
-- BOTH the BYO-AI MCP (for planning) and Yaycay's own first-party curation /
-- serving pipeline. See docs/handoff/MCP-CONTEXT-AND-INTENT.md.
--
-- The itinerary tree lives in trip_content (the "what"). This table holds the
-- intent (the "why"): who is travelling, the pace and budget posture the family
-- wants, the themes they care about, must-dos and no-gos, and a free-text brief.
-- The MCP reads it via get_trip_brief and refines it via set_trip_brief
-- (yaycay.plan); curation reads the same row so context is never re-derived.
--
-- Owner-scoped customer data: standard RLS (owner-or-admin). user_id is
-- denormalised for a clean RLS predicate, exactly as trip_content does.

create table if not exists public.trip_intent (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- How busy a day should feel.
  pace text check (pace is null or pace in ('relaxed', 'balanced', 'packed')),
  -- Spend posture, kept coarse and verb-free.
  budget text check (budget is null or budget in ('budget', 'moderate', 'premium', 'splurge')),
  -- Who is on this trip: [{ name, age?, kind: 'kid'|'adult', interests[], dietary[], notes? }].
  -- A snapshot (a trip may include a subset of child_profiles plus other adults),
  -- seedable from public.child_profiles but owned by the trip.
  travellers jsonb not null default '[]',
  -- Trip-level themes/interests (e.g. 'dinosaurs', 'beaches', 'trains').
  interests text[] not null default '{}',
  -- Non-negotiable wants and hard no-gos.
  must_do text[] not null default '{}',
  avoid text[] not null default '{}',
  -- Free-text "what the family wants from this trip", in their words.
  notes text,
  -- Flexible constraints curation/planning should respect (nap windows,
  -- mobility, allergies summary, travel-sickness, etc.).
  constraints jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trip_intent_user_id_idx on public.trip_intent (user_id);

drop trigger if exists trip_intent_updated_at on public.trip_intent;
create trigger trip_intent_updated_at
  before update on public.trip_intent
  for each row execute function app.touch_updated_at();

-- ----- RLS: owner-or-admin, mirroring trip_content --------------------------
alter table public.trip_intent enable row level security;
alter table public.trip_intent force row level security;

drop policy if exists trip_intent_owner_all on public.trip_intent;
create policy trip_intent_owner_all on public.trip_intent
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid() or app.is_admin());

grant select, insert, update, delete on public.trip_intent to authenticated;
