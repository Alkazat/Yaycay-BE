// Local mirror of the @alkazat/contracts content types. The Deno edge runtime
// does not resolve the workspace package, so the slice the functions need is
// duplicated here. Keep in lockstep with packages/contracts/src/trip-content.ts.

export type MomentSlot = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'anytime';

export type ActivityKind = 'kid' | 'shared' | 'adult';
export type ExplorerMode = 'little' | 'standard' | 'explorer' | 'explorer_plus';

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

export interface Hotel {
  name?: string;
  phase?: 'arrive' | 'stay' | 'depart' | 'move';
  checkin?: string;
  checkout?: string;
  note?: string;
}

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

export type Variants = Partial<Record<ExplorerMode, VariantBlock>>;

export interface Booking {
  name: string;
  time?: string;
  ref?: string;
  notes?: string;
}

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
  facts?: string[];
  challenge?: Challenge;
}

export interface Moment {
  id: string;
  slot: MomentSlot;
  title: string;
  time_hint?: string;
  location?: { name: string; lat?: number; lng?: number; zoom?: number };
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

export interface TripContentHeader {
  id: string;
  destination: string;
  start_date: string;
  end_date: string;
  timezone?: string;
  currency?: string;
}

export interface Grownups {
  essentials?: string;
  checklist?: string[];
  transport?: string;
}

/** The canonical per-trip payload stored in `trip_content.content`. */
export interface TripContent {
  trip: TripContentHeader;
  days: Day[];
  grownups?: Grownups;
}
