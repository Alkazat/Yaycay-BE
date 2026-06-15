-- 0025_support_sessions.sql
-- Admin "support sessions" (view-as): a time-boxed, reason-gated, fully-audited
-- record of an admin inspecting ONE customer's data for a short window.
--
-- This is an OVERSIGHT record, not a credential. No customer login link, access
-- token, refresh token, or auth cookie is ever minted. The admin keeps using
-- the AAL2-gated /admin/* read path (already backed by the service role); a
-- support session merely scopes that access to one customer, time-boxes it,
-- records why, and surfaces it for oversight. Acting AS the customer (writes)
-- is intentionally out of scope - hence the read_only mode check below.

create table if not exists public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  -- The admin who opened the session (JWT sub).
  actor_id uuid not null references auth.users (id),
  actor_email text,
  -- The customer being inspected.
  target_user_id uuid not null references auth.users (id),
  target_email text,
  -- Mandatory justification (e.g. a support ticket reference). Audited.
  reason text not null,
  -- Read-only is the only mode today. The column makes intent explicit and
  -- leaves room for a future, separately-audited write mode without a reshape.
  mode text not null default 'read_only' check (mode in ('read_only')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('manual', 'expired')),
  created_at timestamptz not null default now()
);
create index if not exists support_sessions_actor_idx on public.support_sessions (actor_id);
create index if not exists support_sessions_target_idx on public.support_sessions (target_user_id);
create index if not exists support_sessions_started_idx on public.support_sessions (started_at);
-- An admin may hold at most one open (not-yet-ended) session at a time, so the
-- active view-as is always unambiguous.
create unique index if not exists support_sessions_one_active_per_actor
  on public.support_sessions (actor_id) where ended_at is null;

-- ===== RLS =================================================================
-- Admins read; appends/updates happen via the service role (the /admin/* API
-- path), exactly like admin_audit_log. No client write policy is granted, so a
-- session can only be opened/closed through the audited API.
alter table public.support_sessions enable row level security;
alter table public.support_sessions force row level security;
drop policy if exists support_sessions_admin_select on public.support_sessions;
create policy support_sessions_admin_select on public.support_sessions
  for select using (app.is_admin());

grant select on public.support_sessions to authenticated;
