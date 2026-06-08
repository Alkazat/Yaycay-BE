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

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  variants?: Variants;
  safety?: { note?: string; flags?: string[] };
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
