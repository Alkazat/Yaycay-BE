-- 0009_explorer_standard.sql
-- Add the 'standard' baseline explorer mode (FE three-way modes: little /
-- standard / explorer_plus, with explorer retained). Used by child_profiles.mode
-- and trip_progress.active_mode. Added in its own migration so the new enum value
-- is committed before any later migration or handler uses it.

alter type public.explorer_mode add value if not exists 'standard';
