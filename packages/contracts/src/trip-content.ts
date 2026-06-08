/**
 * Canonical content model: Holiday -> Days -> Moments -> Activities.
 *
 * One `TripContent` per trip. Per-child / per-adult differences are tagging,
 * not duplication: mode/age variants live as tagged blocks inside the one
 * payload and are selected at render by the active profile.
 *
 * This is the hand-authored mirror of `schemas/trip-content.schema.json`,
 * which is the validation source of truth. Keep the two in lockstep.
 */

export type MomentSlot = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'anytime';

/** Routes an activity to the kid view, the shared view, or the grown-ups view. */
export type ActivityKind = 'kid' | 'shared' | 'adult';

/** Kid explorer modes used to pick a {@link Variants} block at render time. */
export type ExplorerMode = 'little' | 'explorer' | 'explorer_plus';

export interface TripContentHeader {
  id: string;
  destination: string;
  start_date: string;
  end_date: string;
  /** IANA timezone name, e.g. `Asia/Singapore`. */
  timezone?: string;
  /** ISO 4217 currency code. */
  currency?: string;
}

export interface Location {
  name: string;
  lat?: number;
  lng?: number;
}

export interface Quiz {
  q: string;
  a: string;
  options?: string[];
}

export interface VariantBlock {
  body?: string;
  fact?: string;
  quiz?: Quiz;
}

/** Mode/age-tagged renderings; the renderer picks the block by active profile. */
export type Variants = Partial<Record<ExplorerMode, VariantBlock>>;

export interface Booking {
  name: string;
  time?: string;
  ref?: string;
  notes?: string;
}

/** Dietary/medical flags surfaced to adults. Sourced from profile data. */
export interface Safety {
  note?: string;
  flags?: string[];
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  variants?: Variants;
  booking?: Booking;
  safety?: Safety;
  /** References to media rows; resolved to signed URLs at read time. */
  media_ref?: string[];
}

export interface Moment {
  id: string;
  slot: MomentSlot;
  title: string;
  /** Soft 24h time hint `HH:MM`; not a hard booking. */
  time_hint?: string;
  location?: Location;
  activities: Activity[];
}

export interface Day {
  id: string;
  date?: string;
  label?: string;
  summary?: string;
  moments: Moment[];
}

export interface Grownups {
  essentials?: string;
  checklist?: string[];
  transport?: string;
}

export interface TripContent {
  trip: TripContentHeader;
  days: Day[];
  grownups?: Grownups;
}
