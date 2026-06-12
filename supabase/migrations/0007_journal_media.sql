-- 0007_journal_media.sql
-- Journal entries and print-grade media (Phase 1, paid tiers).
--
-- Journal entries are per-trip, optionally tagged to a child profile. Media is
-- uploaded straight to private Storage via short-lived signed upload URLs minted
-- server-side; the bytes never pass through the function. A media_assets row
-- records each upload and its `media_ref` is what trip_content / journal entries
-- reference. Reads resolve media_ref to a signed download URL at read time.

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid references public.child_profiles (id) on delete set null,
  body text not null default '',
  media_ref text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists journal_entries_trip_idx on public.journal_entries (trip_id);
create index if not exists journal_entries_user_idx on public.journal_entries (user_id);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete set null,
  -- Storage object path, always prefixed by the owner's user_id.
  path text not null,
  content_type text,
  created_at timestamptz not null default now()
);
create index if not exists media_assets_user_idx on public.media_assets (user_id);

-- ----- RLS -----------------------------------------------------------------
alter table public.journal_entries enable row level security;
alter table public.journal_entries force row level security;
drop policy if exists journal_owner_all on public.journal_entries;
create policy journal_owner_all on public.journal_entries
  for all
  using (user_id = auth.uid() or app.is_admin())
  with check (user_id = auth.uid());

-- media_assets rows are written by the service role (sign-upload mints the path);
-- owners (and admins) read their own.
alter table public.media_assets enable row level security;
alter table public.media_assets force row level security;
drop policy if exists media_owner_select on public.media_assets;
create policy media_owner_select on public.media_assets
  for select
  using (user_id = auth.uid() or app.is_admin());

grant select, insert, update, delete on public.journal_entries to authenticated;
grant select on public.media_assets to authenticated;

-- Private bucket for trip media; all access is via signed URLs.
insert into storage.buckets (id, name, public)
  values ('trip-media', 'trip-media', false)
on conflict (id) do nothing;
