// Trip intent: the "why" behind a trip (public.trip_intent, migration 0024).
//
// Captured once and shared by BOTH the BYO-AI MCP (get/set_trip_brief) and
// Yaycay's first-party planning/curation (the use-our-AI chat reads it as
// context). This module is the single definition of the shape, the columns, and
// how the brief is rendered for a model prompt - see
// docs/handoff/MCP-CONTEXT-AND-INTENT.md.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface Traveller {
  name?: string;
  age?: number;
  kind?: 'kid' | 'adult';
  interests?: string[];
  dietary?: string[];
  notes?: string;
}

export interface TripIntent {
  pace?: string | null;
  budget?: string | null;
  travellers?: Traveller[];
  interests?: string[];
  must_do?: string[];
  avoid?: string[];
  notes?: string | null;
  constraints?: Record<string, unknown>;
}

/** The trip_intent columns the brief is built from (no trip_id/user_id/timestamps). */
export const INTENT_FIELDS = [
  'pace',
  'budget',
  'travellers',
  'interests',
  'must_do',
  'avoid',
  'notes',
  'constraints',
] as const;

/** Read a trip's intent, or null when none has been captured yet. */
export async function readIntent(db: SupabaseClient, tripId: string): Promise<TripIntent | null> {
  const { data } = await db
    .from('trip_intent')
    .select(INTENT_FIELDS.join(', '))
    .eq('trip_id', tripId)
    .maybeSingle();
  return (data as TripIntent) ?? null;
}

function travellerLine(t: Traveller): string {
  const bits: string[] = [];
  if (t.name) bits.push(t.name);
  if (typeof t.age === 'number') bits.push(`age ${t.age}`);
  if (t.interests?.length) bits.push(`likes ${t.interests.join(', ')}`);
  if (t.dietary?.length) bits.push(`dietary: ${t.dietary.join(', ')}`);
  return bits.join(', ');
}

/**
 * Render intent as a short prose brief for a model prompt. Returns '' when there
 * is nothing useful to say, so callers can skip an empty context block.
 */
export function briefText(intent: TripIntent | null): string {
  if (!intent) return '';
  const lines: string[] = [];
  const travellers = (intent.travellers ?? []).map(travellerLine).filter(Boolean);
  if (travellers.length) lines.push(`Travellers: ${travellers.join('; ')}`);
  if (intent.pace) lines.push(`Pace: ${intent.pace}`);
  if (intent.budget) lines.push(`Budget: ${intent.budget}`);
  if (intent.interests?.length) lines.push(`Interests: ${intent.interests.join(', ')}`);
  if (intent.must_do?.length) lines.push(`Must-do: ${intent.must_do.join(', ')}`);
  if (intent.avoid?.length) lines.push(`Avoid: ${intent.avoid.join(', ')}`);
  if (intent.notes) lines.push(`In their words: ${intent.notes}`);
  if (intent.constraints && Object.keys(intent.constraints).length) {
    lines.push(`Constraints: ${JSON.stringify(intent.constraints)}`);
  }
  if (!lines.length) return '';
  return `The family's brief (plan to this):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
