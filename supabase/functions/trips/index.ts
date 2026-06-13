// Customer trip API:
//   GET   /trips                 list the caller's trips (TripSummary[])  (v0.4)
//   POST  /trips                 create a trip                           (v0.1)
//   GET   /trips/:id             read the canonical TripContent          (v0.4)
//   GET   /trips/:id/content     read the canonical trip_content (alias) (v0.1)
//   PATCH /trips/:id/content     replace trip_content (schema-validated) (v0.1)
//   POST  /trips/:id/plan/chat   use-our-AI planning chat (SSE stream)  (v0.3, tier=ours)
//   POST  /trips/:id/ingest      receipt/photo/note -> patched content  (v0.3, paid)
//
// Runs as the authenticated caller; Row-Level Security enforces ownership.
// The AI surfaces additionally log an ai_jobs row and honour the daily cap.

import { corsHeaders, error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { validateTripContent } from '../_shared/trip-content-validate.ts';
import {
  chatGeneratedBy,
  chatModel,
  ingest as runIngest,
  logAiError,
  type ChatMessage,
  type IngestImage,
  planChatDeltas,
} from '../_shared/harness.ts';
import { applyPatch, PatchError, validatePatchShape } from '../_shared/trip-patch.ts';
import type { TripContent } from '../_shared/content-types.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { assertUnderCap, CapReachedError, finishJob, startJob } from '../_shared/ai-jobs.ts';

const TRIP_COLUMNS =
  'id, destination, start_date, end_date, timezone, currency, tier, status, retention_expires_at, created_at';

// GET /trips returns TripSummary: the trip columns plus the content row so we
// can derive day_count; PostgREST embeds the one-to-one trip_content.
const SUMMARY_COLUMNS = `${TRIP_COLUMNS}, trip_content(content)`;

// Shape a trips row (with embedded content) into a TripSummary.
function toSummary(row: Record<string, unknown>): Record<string, unknown> {
  const tc = row.trip_content as { content?: TripContent } | { content?: TripContent }[] | null;
  const embedded = Array.isArray(tc) ? tc[0] : tc;
  const days = embedded?.content?.days;
  const retention = row.retention_expires_at as string | null;
  const { trip_content: _drop, ...trip } = row;
  return {
    ...trip,
    day_count: Array.isArray(days) ? days.length : 0,
    data_kept: retention === null || new Date(retention).getTime() > Date.now(),
  };
}

// Reduce the path to the part after `/trips`.
function segments(url: URL): string[] {
  const marker = '/trips';
  const i = url.pathname.indexOf(marker);
  const sub = i === -1 ? url.pathname : url.pathname.slice(i + marker.length);
  return sub.split('/').filter((s) => s.length > 0);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ValidationError(['Request body must be JSON.']);
  }
}

class ValidationError extends Error {
  constructor(readonly details: string[]) {
    super('validation_error');
  }
}
class NotFoundError extends Error {}

// The trip's tier does not entitle the caller to this AI surface.
class EntitlementError extends Error {
  constructor(readonly required: string[]) {
    super('entitlement_required');
  }
}

const EMPTY_CONTENT: TripContent = { trip: {} as TripContent['trip'], days: [] };

// SSE frame helper for the streaming chat response.
function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const url = new URL(req.url);
    const seg = segments(url);
    const { client, userId } = await userContext(req);

    // /trips
    if (seg.length === 0) {
      if (req.method === 'GET') {
        const { data, error: dbErr } = await client
          .from('trips')
          .select(SUMMARY_COLUMNS)
          .order('created_at', { ascending: false });
        if (dbErr) throw new Error(dbErr.message);
        return json({ trips: (data ?? []).map((r) => toSummary(r as Record<string, unknown>)) });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.destination !== 'string' || body.destination.trim().length === 0) {
          throw new ValidationError(['destination is required']);
        }
        const { data: trip, error: dbErr } = await client
          .from('trips')
          .insert({
            user_id: userId,
            destination: (body.destination as string).trim(),
            start_date: typeof body.start_date === 'string' ? body.start_date : null,
            end_date: typeof body.end_date === 'string' ? body.end_date : null,
            timezone: typeof body.timezone === 'string' ? body.timezone : null,
            currency: typeof body.currency === 'string' ? body.currency : null,
          })
          .select(TRIP_COLUMNS)
          .single();
        if (dbErr) throw new Error(dbErr.message);

        // Seed an empty content row so reads/patches have something to target.
        await client.from('trip_content').insert({ trip_id: trip.id, user_id: userId });
        return json(trip, 201);
      }
      return error('method_not_allowed', 'Use GET or POST.', 405);
    }

    const tripId = seg[0];

    // /trips/:id - the canonical content read (TripContent, per contract §5).
    if (seg.length === 1) {
      if (req.method !== 'GET') return error('method_not_allowed', 'Use GET.', 405);
      const { data, error: dbErr } = await client
        .from('trips')
        .select('id, trip_content(content)')
        .eq('id', tripId)
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) throw new NotFoundError();
      const tc = (
        data as { trip_content?: { content?: TripContent } | { content?: TripContent }[] }
      ).trip_content;
      const embedded = Array.isArray(tc) ? tc[0] : tc;
      return json(embedded?.content ?? EMPTY_CONTENT);
    }

    // /trips/:id/content
    if (seg.length === 2 && seg[1] === 'content') {
      if (req.method === 'GET') {
        const { data, error: dbErr } = await client
          .from('trip_content')
          .select('content')
          .eq('trip_id', tripId)
          .maybeSingle();
        if (dbErr) throw new Error(dbErr.message);
        if (!data) throw new NotFoundError();
        return json(data.content);
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const errors = validateTripContent(body);
        if (errors.length > 0) throw new ValidationError(errors);

        // Confirm the caller owns the trip before writing content.
        const { data: trip } = await client
          .from('trips')
          .select('id')
          .eq('id', tripId)
          .maybeSingle();
        if (!trip) throw new NotFoundError();

        const { data, error: dbErr } = await client
          .from('trip_content')
          .upsert({ trip_id: tripId, user_id: userId, content: body }, { onConflict: 'trip_id' })
          .select('content')
          .single();
        if (dbErr) throw new Error(dbErr.message);
        return json(data.content);
      }
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    // /trips/:id/plan/chat - use-our-AI planning chat (streamed).
    if (seg.length === 3 && seg[1] === 'plan' && seg[2] === 'chat') {
      if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);
      return await handlePlanChat(client, userId, tripId, req);
    }

    // /trips/:id/ingest - receipt/photo/note -> patched content.
    if (seg.length === 2 && seg[1] === 'ingest') {
      if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);
      return await handleIngest(client, userId, tripId, req);
    }

    // /trips/:id/journal - per-trip journal (read by owner; write is paid).
    if (seg.length === 2 && seg[1] === 'journal') {
      if (req.method === 'GET') return await handleJournalList(client, tripId, url);
      if (req.method === 'POST') return await handleJournalCreate(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or POST.', 405);
    }

    // /trips/:id/progress - per-profile state (done items + active mode).
    if (seg.length === 2 && seg[1] === 'progress') {
      if (req.method === 'GET') return await handleProgressGet(client, tripId, url);
      if (req.method === 'PATCH') return await handleProgressUpdate(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    return error('not_found', 'No such route.', 404);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return error('unauthorized', err.message, 401);
    }
    if (err instanceof ValidationError) {
      return error('validation_error', 'Request failed validation.', 422, err.details);
    }
    if (err instanceof NotFoundError) {
      return error('not_found', 'Resource not found or not visible to the caller.', 404);
    }
    if (err instanceof EntitlementError) {
      return error(
        'entitlement_required',
        'This AI feature is not available on the trip’s current tier.',
        403,
        [`Requires tier: ${err.required.join(' or ')}.`],
      );
    }
    if (err instanceof CapReachedError) {
      return error(
        'cap_reached',
        `This trip has used its ${err.limit} AI updates for today. Try again tomorrow.`,
        429,
      );
    }
    if (err instanceof PatchError) {
      return error('validation_error', 'The AI edit could not be applied.', 422, [err.message]);
    }
    console.error('trips handler error', err);
    return error('internal_error', 'Unexpected error.', 500);
  }
});

// ----- AI surfaces -----------------------------------------------------------

// Load a trip the caller can see (RLS), returning its tier; null when absent.
async function loadTier(
  client: Awaited<ReturnType<typeof userContext>>['client'],
  tripId: string,
): Promise<string | null> {
  const { data, error: dbErr } = await client
    .from('trips')
    .select('id, tier')
    .eq('id', tripId)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  return data ? (data.tier as string) : null;
}

async function readContent(
  client: Awaited<ReturnType<typeof userContext>>['client'],
  tripId: string,
): Promise<TripContent> {
  const { data, error: dbErr } = await client
    .from('trip_content')
    .select('content')
    .eq('trip_id', tripId)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  return (data?.content as TripContent) ?? EMPTY_CONTENT;
}

type UserClient = Awaited<ReturnType<typeof userContext>>['client'];

async function handlePlanChat(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const tier = await loadTier(client, tripId);
  if (tier === null) throw new NotFoundError();
  if (tier !== 'ours') throw new EntitlementError(['ours']);

  const body = await readJson(req);
  const messages = parseChatMessages(body.messages);
  if (messages.length === 0) throw new ValidationError(['messages must be a non-empty array']);

  const destination = await tripDestination(client, tripId);
  const content = await readContent(client, tripId);

  // Cap + ledger use the service role: ai_jobs withholds insert from clients.
  const svc = serviceClient();
  await assertUnderCap(svc, tripId);
  const jobId = await startJob(svc, { userId, tripId, kind: 'chat', model: chatModel() });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse({ start: true, generated_by: chatGeneratedBy() }));
      try {
        for await (const delta of planChatDeltas({ destination, content, messages })) {
          controller.enqueue(sse({ delta }));
        }
        controller.enqueue(sse({ done: true, job_id: jobId }));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        await finishJob(svc, jobId, 'succeeded');
      } catch (err) {
        logAiError('chat', err);
        controller.enqueue(sse({ error: 'chat_failed' }));
        await finishJob(svc, jobId, 'failed', err instanceof Error ? err.message : String(err));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

async function handleIngest(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const tier = await loadTier(client, tripId);
  if (tier === null) throw new NotFoundError();
  if (tier !== 'byo' && tier !== 'ours') throw new EntitlementError(['byo', 'ours']);

  const body = await readJson(req);
  const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text : undefined;
  const image = parseIngestImage(body.image);
  if (!text && !image) throw new ValidationError(['Provide text or image to ingest.']);
  const hint = parseHint(body.hint);

  const destination = await tripDestination(client, tripId);
  const content = await readContent(client, tripId);

  const svc = serviceClient();
  await assertUnderCap(svc, tripId);
  const jobId = await startJob(svc, { userId, tripId, kind: 'ingestion' });

  try {
    const result = await runIngest({ destination, text, image, hint, content });

    const shapeErrors = validatePatchShape(result.patch);
    if (shapeErrors.length > 0) throw new ValidationError(shapeErrors);

    const next = applyPatch(content, result.patch);
    const contentErrors = validateTripContent(next);
    if (contentErrors.length > 0) throw new ValidationError(contentErrors);

    const { error: dbErr } = await client
      .from('trip_content')
      .upsert({ trip_id: tripId, user_id: userId, content: next }, { onConflict: 'trip_id' });
    if (dbErr) throw new Error(dbErr.message);

    await finishJob(svc, jobId, 'succeeded');
    return json(
      {
        applied: true,
        job_id: jobId,
        generated_by: result.generated_by,
        patch: result.patch,
        content: next,
      },
      200,
    );
  } catch (err) {
    await finishJob(svc, jobId, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

const JOURNAL_COLUMNS = 'id, trip_id, profile_id, body, media_ref, created_at';

async function handleJournalList(client: UserClient, tripId: string, url: URL): Promise<Response> {
  let q = client
    .from('journal_entries')
    .select(JOURNAL_COLUMNS)
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false });
  const profileId = url.searchParams.get('profile_id');
  if (profileId) q = q.eq('profile_id', profileId);
  const { data, error: dbErr } = await q;
  if (dbErr) throw new Error(dbErr.message);
  return json({ entries: data ?? [] });
}

async function handleJournalCreate(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const tier = await loadTier(client, tripId);
  if (tier === null) throw new NotFoundError();
  if (tier !== 'byo' && tier !== 'ours') throw new EntitlementError(['byo', 'ours']);

  const body = await readJson(req);
  const text = typeof body.body === 'string' ? body.body : '';
  const profileId = typeof body.profile_id === 'string' ? body.profile_id : null;
  const mediaRef = Array.isArray(body.media_ref)
    ? (body.media_ref as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (text.trim().length === 0 && mediaRef.length === 0) {
    throw new ValidationError(['Provide body text or media_ref.']);
  }

  const { data, error: dbErr } = await client
    .from('journal_entries')
    .insert({
      trip_id: tripId,
      user_id: userId,
      profile_id: profileId,
      body: text,
      media_ref: mediaRef,
    })
    .select(JOURNAL_COLUMNS)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json(data, 201);
}

// ----- Progress (per-profile state) ------------------------------------------

const PROGRESS_COLUMNS = 'profile_id, active_mode, done_items, updated_at';
const EXPLORER_MODES = ['little', 'standard', 'explorer', 'explorer_plus'];

function toProgress(r: Record<string, unknown>): Record<string, unknown> {
  return {
    profile_id: (r.profile_id as string | null) ?? null,
    active_mode: (r.active_mode as string | null) ?? null,
    done_items: Array.isArray(r.done_items) ? r.done_items : [],
    updated_at: r.updated_at as string,
  };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function handleProgressGet(client: UserClient, tripId: string, url: URL): Promise<Response> {
  // Confirm the caller can see the trip (RLS) so an unknown id is a clean 404.
  const { data: trip } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) throw new NotFoundError();

  let q = client.from('trip_progress').select(PROGRESS_COLUMNS).eq('trip_id', tripId);
  const profileId = url.searchParams.get('profile_id');
  if (profileId) q = q.eq('profile_id', profileId);
  const { data, error: dbErr } = await q;
  if (dbErr) throw new Error(dbErr.message);
  return json({ progress: (data ?? []).map((r) => toProgress(r as Record<string, unknown>)) });
}

async function handleProgressUpdate(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const body = await readJson(req);
  const profileId = typeof body.profile_id === 'string' ? body.profile_id : null;
  if (!profileId) throw new ValidationError(['profile_id is required']);
  if (body.active_mode !== undefined && !EXPLORER_MODES.includes(String(body.active_mode))) {
    throw new ValidationError(['active_mode must be little|standard|explorer|explorer_plus']);
  }

  // Caller must own the trip (RLS) before writing progress.
  const { data: trip } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) throw new NotFoundError();

  // Merge against the existing row so incremental mark_done/mark_undone work.
  const { data: existing } = await client
    .from('trip_progress')
    .select(PROGRESS_COLUMNS)
    .eq('trip_id', tripId)
    .eq('profile_id', profileId)
    .maybeSingle();

  let done = new Set<string>(asStringArray(existing?.done_items));
  if (Array.isArray(body.done_items)) done = new Set(asStringArray(body.done_items));
  for (const id of asStringArray(body.mark_done)) done.add(id);
  for (const id of asStringArray(body.mark_undone)) done.delete(id);

  const activeMode =
    typeof body.active_mode === 'string'
      ? body.active_mode
      : ((existing?.active_mode as string | null | undefined) ?? null);

  const { data, error: dbErr } = await client
    .from('trip_progress')
    .upsert(
      {
        trip_id: tripId,
        user_id: userId,
        profile_id: profileId,
        active_mode: activeMode,
        done_items: [...done],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'trip_id,profile_id' },
    )
    .select(PROGRESS_COLUMNS)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json(toProgress(data as Record<string, unknown>));
}

async function tripDestination(client: UserClient, tripId: string): Promise<string> {
  const { data } = await client.from('trips').select('destination').eq('id', tripId).maybeSingle();
  return (data?.destination as string) ?? '';
}

function parseChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const o = m as Record<string, unknown>;
    if ((o?.role === 'user' || o?.role === 'assistant') && typeof o.content === 'string') {
      out.push({ role: o.role, content: o.content });
    }
  }
  return out;
}

function parseIngestImage(raw: unknown): IngestImage | undefined {
  const o = raw as Record<string, unknown> | undefined;
  if (o && typeof o.media_type === 'string' && typeof o.data === 'string' && o.data.length > 0) {
    return { media_type: o.media_type, data: o.data };
  }
  return undefined;
}

function parseHint(raw: unknown): { day_id?: string; moment_id?: string } | undefined {
  const o = raw as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const hint: { day_id?: string; moment_id?: string } = {};
  if (typeof o.day_id === 'string') hint.day_id = o.day_id;
  if (typeof o.moment_id === 'string') hint.moment_id = o.moment_id;
  return hint.day_id || hint.moment_id ? hint : undefined;
}
