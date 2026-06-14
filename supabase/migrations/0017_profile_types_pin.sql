-- 0017_profile_types_pin.sql
-- User types: a profile is a child or a guardian. Guardians can set a 4-digit
-- PIN that gates the Grown-ups view. The PIN is hashed server-side (never
-- returned - only `pin_set` is exposed) and verification is rate-limited.

alter table public.child_profiles
  add column if not exists type text not null default 'child'
    check (type in ('child', 'guardian')),
  add column if not exists pin_hash text,
  add column if not exists pin_attempts int not null default 0,
  add column if not exists pin_locked_until timestamptz;
