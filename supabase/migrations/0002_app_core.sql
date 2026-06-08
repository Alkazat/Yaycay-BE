-- 0002_app_core.sql
-- App database: trips and the canonical content model, plus the tables Phase 0
-- touches directly (child profiles, the AI job log, marketing contacts).
-- Customer data lives in `public`; helper functions live in `app`.
-- Joins reference user_id only (identity is isolated, see 0001_identity.sql).

create schema if not exists app;

-- ----- Enums ---------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'trip_tier') then
    create type public.trip_tier as enum ('free', 'byo', 'ours');
  end if;
  if not exists (select 1 from pg_type where typname = 'trip_status') then
    create type public.trip_status as enum
      ('draft', 'planning', 'ready', 'holidaying', 'complete', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'explorer_mode') then
    create type public.explorer_mode as enum ('little', 'explorer', 'explorer_plus');
  end if;
  if not exists (select 1 from pg_type where typname = 'ai_job_kind') then
    create type public.ai_job_kind as enum ('generate', 'ingest', 'chat');
  end if;
  if not exists (select 1 from pg_type where typname = 'ai_job_status') then
    create type public.ai_job_status as enum ('queued', 'running', 'succeeded', 'failed');
  end if;
end $$;

-- ----- Helpers -------------------------------------------------------------
-- Admin check reads the isolated identity store via a definer function so the
-- locked-down schema stays unreadable to client roles.
create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = identity, public
as $$
  select exists (
    select 1 from identity.accounts a
    where a.user_id = auth.uid() and a.role = 'admin'
  );
$$;

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----- child_profiles ------------------------------------------------------
create table if not exists public.child_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  avatar text,
  age int check (age between 0 and 18),
  mode public.explorer_mode,
  interests text[] not null default '{}',
  -- Dietary/medical flags surface to adults as content safety notes.
  dietary text[] not null default '{}',
  medical text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists child_profiles_user_id_idx on public.child_profiles (user_id);

-- ----- trips ---------------------------------------------------------------
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  destination text not null,
  start_date date,
  end_date date,
  timezone text,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  tier public.trip_tier not null default 'free',
  status public.trip_status not null default 'draft',
  -- Disposal by default: scheduled deletion 12 months post-holiday unless a
  -- keep-token extends it. Driven by the retention job (Phase 2).
  retention_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_dates_ordered check (
    start_date is null or end_date is null or end_date >= start_date
  )
);
create index if not exists trips_user_id_idx on public.trips (user_id);
create index if not exists trips_retention_idx on public.trips (retention_expires_at);

-- ----- trip_content --------------------------------------------------------
-- One JSON payload per trip; validated against trip-content.schema.json on the
-- API boundary before write. user_id is denormalised for a clean RLS predicate.
create table if not exists public.trip_content (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  content jsonb not null default '{"trip":{},"days":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists trip_content_user_id_idx on public.trip_content (user_id);

-- ----- trip_progress -------------------------------------------------------
-- Per-profile state, tagged by profile_id: done items and active mode.
create table if not exists public.trip_progress (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid references public.child_profiles (id) on delete cascade,
  active_mode public.explorer_mode,
  done_items text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (trip_id, profile_id)
);
create index if not exists trip_progress_user_id_idx on public.trip_progress (user_id);

-- ----- ai_jobs -------------------------------------------------------------
-- Every chat/ingestion/generation job is logged here. Enforces the ~10/day cap
-- per trip (Phase 1); records the model + prompt version used.
create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  kind public.ai_job_kind not null,
  status public.ai_job_status not null default 'queued',
  model text,
  prompt_version text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_jobs_trip_day_idx on public.ai_jobs (trip_id, created_at);

-- ----- marketing_contacts --------------------------------------------------
-- Every signup (free or paid) becomes a row and syncs to Brevo with consent.
create table if not exists public.marketing_contacts (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: leads are captured before an auth user exists.
  user_id uuid references auth.users (id) on delete set null,
  email text not null,
  name text,
  source text,
  consent boolean not null default false,
  brevo_synced_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Email is stored lower-cased by the capture path; a plain unique index lets
-- PostgREST upsert with onConflict=email.
create unique index if not exists marketing_contacts_email_key
  on public.marketing_contacts (email);

-- ----- updated_at triggers -------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'child_profiles', 'trips', 'trip_progress', 'marketing_contacts'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I;', t || '_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function app.touch_updated_at();',
      t || '_updated_at', t
    );
  end loop;
end $$;

drop trigger if exists trip_content_updated_at on public.trip_content;
create trigger trip_content_updated_at
  before update on public.trip_content
  for each row execute function app.touch_updated_at();
