-- 0016_journal_day_id.sql
-- The FE journal is day-scoped: entries are created against a specific content
-- day (TripContent.days[].id, e.g. "d_2"), badged per day, and the keepsake
-- export groups by day. Add a nullable day_id so the association round-trips;
-- null means a trip-level (not day-specific) entry.

alter table public.journal_entries
  add column if not exists day_id text;
