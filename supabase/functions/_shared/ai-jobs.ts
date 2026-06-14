// The AI-job ledger and the per-trip daily cap.
//
// Every chat/ingestion/generation call writes an `ai_jobs` row; the row is the
// unit the ~10/day-per-trip cap counts, and what the admin jobs view reads. The
// table grants owners select only, so writes go through the service role. The
// cap window is the current UTC day, matching admin/routes/jobs.ts:capUsed so
// the customer path and the admin meter agree.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { optionalEnv } from './env.ts';

export type AiJobKind = 'generation' | 'ingestion' | 'chat';
export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export const DEFAULT_DAILY_CAP = Number(optionalEnv('AI_DAILY_CAP_PER_TRIP') ?? '10');

/** Raised when a trip has used its allotted AI updates for the UTC day. */
export class CapReachedError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super('daily_cap_reached');
  }
}

/** Count today's (UTC) AI jobs for a trip. */
export async function capUsed(db: SupabaseClient, tripId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from('ai_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('trip_id', tripId)
    .gte('created_at', startOfDay.toISOString());
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Throw {@link CapReachedError} when the trip is at or over the daily cap. */
export async function assertUnderCap(
  db: SupabaseClient,
  tripId: string,
  limit = DEFAULT_DAILY_CAP,
): Promise<void> {
  const used = await capUsed(db, tripId);
  if (used >= limit) throw new CapReachedError(used, limit);
}

export interface StartJobInput {
  userId: string;
  tripId: string;
  kind: AiJobKind;
  model?: string;
  promptVersion?: string;
  /** 'ours' (default) for our guardrailed pipeline; 'connector' for BYO-AI. */
  source?: 'ours' | 'connector';
  /** When source = connector: the oauth_grants id + assistant label. */
  connectorId?: string | null;
  assistant?: string | null;
}

/** Insert a running job row and return its id. Never throws on logging error. */
export async function startJob(db: SupabaseClient, input: StartJobInput): Promise<string | null> {
  const { data, error } = await db
    .from('ai_jobs')
    .insert({
      user_id: input.userId,
      trip_id: input.tripId,
      kind: input.kind,
      status: 'running' as AiJobStatus,
      model: input.model ?? null,
      prompt_version: input.promptVersion ?? null,
      source: input.source ?? 'ours',
      connector_id: input.connectorId ?? null,
      assistant: input.assistant ?? null,
    })
    .select('id')
    .single();
  if (error) {
    console.error('ai_jobs insert failed', error.message);
    return null;
  }
  return data.id as string;
}

/** Mark a job succeeded/failed. Best-effort; a logging miss never fails a request. */
export async function finishJob(
  db: SupabaseClient,
  jobId: string | null,
  status: 'succeeded' | 'failed',
  errorText?: string,
): Promise<void> {
  if (!jobId) return;
  const { error } = await db
    .from('ai_jobs')
    .update({ status, error: errorText ?? null })
    .eq('id', jobId);
  if (error) console.error('ai_jobs update failed', error.message);
}
