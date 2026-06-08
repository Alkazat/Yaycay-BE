-- 0004_admin_v0_2.sql
-- The admin-scoped surface (contract v0.2): prompt harness, model routing,
-- content review, an append-only audit log, and the commerce catalogue +
-- entitlement tables. RLS confines the admin tables to role=admin; AAL2 (MFA)
-- is enforced at the API boundary, not in SQL.

-- ----- Align ai_jobs.kind with the published contract ----------------------
-- The contract uses generation/ingestion/chat; Phase 0 shipped generate/ingest.
-- Rename the enum values (PG15) so existing rows and policies carry over.
do $$ begin
  if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
             where t.typname = 'ai_job_kind' and e.enumlabel = 'generate') then
    alter type public.ai_job_kind rename value 'generate' to 'generation';
  end if;
  if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
             where t.typname = 'ai_job_kind' and e.enumlabel = 'ingest') then
    alter type public.ai_job_kind rename value 'ingest' to 'ingestion';
  end if;
end $$;

-- ----- Enums ---------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'ai_model') then
    create type public.ai_model as enum ('claude-sonnet', 'claude-opus', 'gemini', 'openai');
  end if;
  if not exists (select 1 from pg_type where typname = 'content_review_status') then
    create type public.content_review_status as enum ('pending', 'approved', 'edited');
  end if;
end $$;

-- ----- prompts -------------------------------------------------------------
-- Versions are immutable; editing creates a new version. Exactly one active
-- version per task. The model is chosen per prompt version.
create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  task text not null,
  title text not null,
  body text not null,
  model public.ai_model not null,
  version int not null,
  active boolean not null default false,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (task, version)
);
-- At most one active version per task.
create unique index if not exists prompts_one_active_per_task
  on public.prompts (task) where active;
create index if not exists prompts_task_idx on public.prompts (task);

-- ----- model_routes --------------------------------------------------------
create table if not exists public.model_routes (
  task text primary key,
  default_model public.ai_model not null,
  override public.ai_model,
  updated_at timestamptz not null default now()
);

-- ----- content_review ------------------------------------------------------
create table if not exists public.content_review (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  status public.content_review_status not null default 'pending',
  generated_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz
);
create index if not exists content_review_status_idx on public.content_review (status);

-- ----- admin_audit_log -----------------------------------------------------
-- Append-only. Every /admin/* call is logged (actor, action, target,
-- before/after for writes). No update/delete is granted to any client role.
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references auth.users (id),
  action text not null,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at);
create index if not exists admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

-- ----- products / purchases ------------------------------------------------
create table if not exists public.products (
  price_id text primary key,
  name text not null,
  amount_usd numeric(10, 2) not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  trip_id uuid references public.trips (id) on delete set null,
  price_id text references public.products (price_id),
  tier public.trip_tier,
  amount_usd numeric(10, 2),
  -- Stripe identifiers; unique for webhook idempotency.
  stripe_session_id text unique,
  stripe_payment_intent text unique,
  created_at timestamptz not null default now()
);
create index if not exists purchases_user_id_idx on public.purchases (user_id);

-- ----- identity: record data-deletion requests -----------------------------
alter table identity.accounts
  add column if not exists deletion_requested_at timestamptz;

-- The admin handlers read/write accounts through the service role over
-- PostgREST. Grant the service role access to the isolated schema; anon and
-- authenticated remain revoked (see 0001_identity.sql), so isolation holds.
grant usage on schema identity to service_role;
grant select, update on identity.accounts to service_role;

-- ----- updated_at triggers -------------------------------------------------
drop trigger if exists prompts_updated_at on public.prompts;
create trigger prompts_updated_at
  before update on public.prompts
  for each row execute function app.touch_updated_at();

drop trigger if exists model_routes_updated_at on public.model_routes;
create trigger model_routes_updated_at
  before update on public.model_routes
  for each row execute function app.touch_updated_at();

-- ===== RLS =================================================================
-- Admin-managed tables: readable/writable only by role=admin.
do $$
declare
  t text;
begin
  foreach t in array array['prompts', 'model_routes', 'content_review'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists %I_admin_all on public.%I;', t, t);
    execute format(
      'create policy %I_admin_all on public.%I for all using (app.is_admin()) with check (app.is_admin());',
      t, t
    );
  end loop;
end $$;

-- Audit log: admins read; appends happen via the service role / definer paths.
alter table public.admin_audit_log enable row level security;
alter table public.admin_audit_log force row level security;
drop policy if exists admin_audit_log_admin_select on public.admin_audit_log;
create policy admin_audit_log_admin_select on public.admin_audit_log
  for select using (app.is_admin());

-- Products: catalogue is readable by any signed-in client; writes are admin.
alter table public.products enable row level security;
alter table public.products force row level security;
drop policy if exists products_read on public.products;
create policy products_read on public.products
  for select using (true);
drop policy if exists products_admin_write on public.products;
create policy products_admin_write on public.products
  for all using (app.is_admin()) with check (app.is_admin());

-- Purchases: an owner reads their own; admins read all. Writes are service-role
-- only (the Stripe webhook), so no client write policy is granted.
alter table public.purchases enable row level security;
alter table public.purchases force row level security;
drop policy if exists purchases_owner_select on public.purchases;
create policy purchases_owner_select on public.purchases
  for select using (user_id = auth.uid() or app.is_admin());

-- ----- grants --------------------------------------------------------------
-- RLS above constrains every row; grants just open the table to the role.
grant select, insert, update, delete on
  public.prompts,
  public.model_routes,
  public.content_review
  to authenticated;
grant select on public.admin_audit_log to authenticated;
grant select, insert, update on public.products to authenticated;
grant select on public.products to anon;
grant select on public.purchases to authenticated;
