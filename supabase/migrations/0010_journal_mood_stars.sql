-- 0010_journal_mood_stars.sql
-- Journal entries gain a mood and a 1-5 star rating (FE memory-book editor).
--
-- Both are optional and additive: existing rows and existing clients are
-- unaffected. `mood` is a short free-text label (e.g. an emoji or word the FE
-- maps to its mood picker); `stars` is a 1-5 rating of the day/moment.

alter table public.journal_entries
  add column if not exists mood text,
  add column if not exists stars int
    check (stars is null or stars between 1 and 5);
