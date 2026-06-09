// Local mirror of the @alkazat/contracts content types. The Deno edge runtime
// does not resolve the workspace package, so the slice the functions need is
// duplicated here. Keep in lockstep with packages/contracts/src/trip-content.ts.

export type MomentSlot = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'anytime';

export type ActivityKind = 'kid' | 'shared' | 'adult';
export type ExplorerMode = 'little' | 'explorer' | 'explorer_plus';

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
}

export interface Moment {
  id: string;
  slot: MomentSlot;
  title: string;
  time_hint?: string;
  location?: { name: string; lat?: number; lng?: number };
  activities: Activity[];
}

export interface Day {
  id: string;
  date?: string;
  label?: string;
  summary?: string;
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
