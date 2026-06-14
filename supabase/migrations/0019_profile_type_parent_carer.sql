-- 0019_profile_type_parent_carer.sql
-- Rename the non-child profile type `guardian` -> `parent_carer` (canon naming).
-- 0017 introduced child_profiles.type with a CHECK of ('child', 'guardian');
-- this rebases that to ('child', 'parent_carer') and migrates existing rows.

alter table public.child_profiles
  drop constraint if exists child_profiles_type_check;

update public.child_profiles
  set type = 'parent_carer'
  where type = 'guardian';

alter table public.child_profiles
  add constraint child_profiles_type_check check (type in ('child', 'parent_carer'));
