-- 0021_chat_companion.sql
-- Persisted planning-chat history + "what's nearby" companion cards, so the
-- planning chat is reopenable and companion answers can be pre-loaded (demo
-- screenshots, and later real users). Reads are owner-scoped; writes are done by
-- the service role (the admin upload endpoints + the demo seed).

create table if not exists public.trip_chat_messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  -- 'text' for normal turns; 'import_chip' for a forwarded confirmation card.
  kind text not null default 'text' check (kind in ('text', 'import_chip')),
  content text not null default '',
  meta jsonb,
  seq int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists trip_chat_messages_trip_idx
  on public.trip_chat_messages (trip_id, seq, created_at);

create table if not exists public.trip_companion_cards (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  near_label text,
  prompt text,
  -- [{ name, flags: string[], note }]; flags carry the allergy text label.
  options jsonb not null default '[]'::jsonb,
  -- { title, body } one-tap indoor fallback.
  rain_plan jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trip_companion_cards_trip_idx
  on public.trip_companion_cards (trip_id, created_at);

-- ----- RLS -----------------------------------------------------------------
-- Owners (and admins) read their own; all writes go through the service role.
alter table public.trip_chat_messages enable row level security;
alter table public.trip_chat_messages force row level security;
drop policy if exists trip_chat_owner_select on public.trip_chat_messages;
create policy trip_chat_owner_select on public.trip_chat_messages
  for select
  using (user_id = auth.uid() or app.is_admin());

alter table public.trip_companion_cards enable row level security;
alter table public.trip_companion_cards force row level security;
drop policy if exists trip_companion_owner_select on public.trip_companion_cards;
create policy trip_companion_owner_select on public.trip_companion_cards
  for select
  using (user_id = auth.uid() or app.is_admin());

grant select on public.trip_chat_messages to authenticated;
grant select on public.trip_companion_cards to authenticated;
