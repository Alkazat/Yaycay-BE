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
export type ExplorerMode = 'little' | 'standard' | 'explorer' | 'explorer_plus';

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
  /** Map zoom level for this location. */
  zoom?: number;
}

/** A typed challenge with an optional revealable answer. */
export type ChallengeType = 'quiz' | 'spot' | 'photo' | 'challenge';

export interface Challenge {
  type: ChallengeType;
  prompt: string;
  answer?: string;
  options?: string[];
  stars?: number;
}

export interface Weather {
  summary?: string;
  high?: number;
  low?: number;
  icon?: string;
}

/** Accommodation / move badge for a day. */
export interface Hotel {
  name?: string;
  phase?: 'arrive' | 'stay' | 'depart' | 'move';
  checkin?: string;
  checkout?: string;
  note?: string;
}

/** Per-day mini-game; `config` is game-specific. */
export interface Game {
  type: 'tap_collect' | 'colouring' | 'spot_it';
  title?: string;
  stars?: number;
  config?: Record<string, unknown>;
}

export interface StarChallenge {
  title: string;
  prompt?: string;
  stars?: number;
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
  /** Did-you-know / fact bubbles for this activity. */
  facts?: string[];
  challenge?: Challenge;
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
  did_you_know?: string;
  weather?: Weather;
  hotel?: Hotel;
  game?: Game;
  star_challenge?: StarChallenge;
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
