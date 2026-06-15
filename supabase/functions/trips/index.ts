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
import { UnauthorizedError, userContext } from '../_shared/user-client.ts';
import { validateTripContent } from '../_shared/trip-content-validate.ts';
import {
  chatGeneratedBy,
  type ChatMessage,
  chatModel,
  ingest as runIngest,
  type IngestImage,
  logAiError,
  planChatDeltas,
} from '../_shared/harness.ts';
import {
  applyPatch,
  PatchError,
  type TripContentPatch,
  validatePatchShape,
} from '../_shared/trip-patch.ts';
import type { TripContent } from '../_shared/content-types.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { assertUnderCap, CapReachedError, finishJob, startJob } from '../_shared/ai-jobs.ts';
import { briefText, INTENT_FIELDS, readIntent } from '../_shared/trip-intent.ts';

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

        // A connector-driven write (FE MCP server forwards x-yaycay-source) must
        // be observable + capped + reviewed, like any external-model mutation.
        const fromConnector = req.headers.get('x-yaycay-source') === 'connector';
        if (fromConnector) {
          const svc = serviceClient();
          await assertUnderCap(svc, tripId);
          const { data, error: dbErr } = await client
            .from('trip_content')
            .upsert({ trip_id: tripId, user_id: userId, content: body }, { onConflict: 'trip_id' })
            .select('content')
            .single();
          if (dbErr) throw new Error(dbErr.message);
          const jobId = await startJob(svc, {
            userId,
            tripId,
            kind: 'ingestion',
            model: 'byo',
            source: 'connector',
            connectorId: req.headers.get('x-yaycay-connector-id'),
            assistant: req.headers.get('x-yaycay-assistant'),
          });
          await finishJob(svc, jobId, 'succeeded');
          await svc
            .from('content_review')
            .upsert(
              { trip_id: tripId, status: 'pending', generated_at: new Date().toISOString() },
              { onConflict: 'trip_id' },
            );
          return json(data.content);
        }

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

    // /trips/:id/content/patch - apply structured ops (add/update/move ...) to
    // the saved itinerary, so the connector's edits persist - validated + capped
    // + content-reviewed exactly like a full content write.
    if (seg.length === 3 && seg[1] === 'content' && seg[2] === 'patch') {
      if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);
      const body = await readJson(req);
      const shapeErrors = validatePatchShape(body);
      if (shapeErrors.length > 0) throw new ValidationError(shapeErrors);
      const { data: cur } = await client
        .from('trip_content')
        .select('content')
        .eq('trip_id', tripId)
        .maybeSingle();
      const current = (cur?.content as TripContent | undefined) ?? EMPTY_CONTENT;
      let nextContent: TripContent;
      try {
        nextContent = applyPatch(current, body as unknown as TripContentPatch);
      } catch (e) {
        if (e instanceof PatchError) throw new ValidationError([e.message]);
        throw e;
      }
      const vErrors = validateTripContent(nextContent);
      if (vErrors.length > 0) throw new ValidationError(vErrors);
      return json(await persistContent(client, userId, tripId, nextContent, req));
    }

    // /trips/:id/intent - the trip brief / "why": pace, budget, travellers,
    // interests, must-dos, avoids, and free-form constraints (allergies, meal
    // notes, nap windows). Read + patch-write (only provided fields change).
    if (seg.length === 2 && seg[1] === 'intent') {
      if (req.method === 'GET') return await handleIntentGet(client, tripId);
      if (req.method === 'PUT' || req.method === 'PATCH') {
        return await handleIntentPut(client, userId, tripId, req);
      }
      return error('method_not_allowed', 'Use GET or PUT.', 405);
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

    // /trips/:id/chat - reopenable planning-chat history (read-only here;
    // content is loaded by the admin upload endpoint / demo seed).
    if (seg.length === 2 && seg[1] === 'chat') {
      if (req.method === 'GET') return await handleChatList(client, tripId);
      return error('method_not_allowed', 'Use GET.', 405);
    }

    // /trips/:id/companion - pre-loaded "what's nearby" companion cards.
    if (seg.length === 2 && seg[1] === 'companion') {
      if (req.method === 'GET') return await handleCompanionList(client, tripId);
      return error('method_not_allowed', 'Use GET.', 405);
    }

    // /trips/:id/progress - per-profile state (done items + active mode).
    if (seg.length === 2 && seg[1] === 'progress') {
      if (req.method === 'GET') return await handleProgressGet(client, tripId, url);
      if (req.method === 'PATCH') return await handleProgressUpdate(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    // /trips/:id/stars  ·  /trips/:id/stars/claim - the reward economy.
    if (seg[1] === 'stars') {
      if (seg.length === 2 && req.method === 'GET') {
        return await handleStarsGet(client, tripId, url);
      }
      if (seg.length === 3 && seg[2] === 'claim' && req.method === 'POST') {
        return await handleStarsClaim(client, userId, tripId, req);
      }
      return error('method_not_allowed', 'Use GET /stars or POST /stars/claim.', 405);
    }

    // /trips/:id/packing - one collection endpoint. PATCH carries an action
    // (tick|add|delete|reset) and every mutation returns the whole { lists } so
    // the FE drops it straight into state - no client merge, no refetch.
    if (seg.length === 2 && seg[1] === 'packing') {
      if (req.method === 'GET') return await handlePackingGet(client, tripId);
      if (req.method === 'PATCH') return await handlePackingPatch(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    // /trips/:id/grownups/checklist - persisted grown-ups checklist ticks.
    if (seg.length === 3 && seg[1] === 'grownups' && seg[2] === 'checklist') {
      if (req.method === 'GET') return await handleChecklistGet(client, tripId);
      if (req.method === 'PATCH') return await handleChecklistUpdate(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    // /trips/:id/reservations - the family's track-and-confirm booking record
    // (no payments). POST adds one; PATCH /:rid moves status / edits fields.
    if (seg.length === 2 && seg[1] === 'reservations') {
      if (req.method === 'GET') return await handleReservationsList(client, tripId);
      if (req.method === 'POST') return await handleReservationCreate(client, userId, tripId, req);
      return error('method_not_allowed', 'Use GET or POST.', 405);
    }
    if (seg.length === 3 && seg[1] === 'reservations') {
      if (req.method === 'PATCH') {
        return await handleReservationUpdate(client, tripId, seg[2], req);
      }
      return error('method_not_allowed', 'Use PATCH.', 405);
    }

    // /trips/:id/features - per-explorer feature toggles (sparse overrides on
    // top of the age-band defaults). GET lists every profile's row; PUT upserts
    // one profile's overrides.
    if (seg.length === 2 && seg[1] === 'features') {
      if (req.method === 'GET') return await handleFeaturesGet(client, tripId);
      if (req.method === 'PUT' || req.method === 'PATCH') {
        return await handleFeaturesPut(client, userId, tripId, req);
      }
      return error('method_not_allowed', 'Use GET or PUT.', 405);
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
  // Same intent the BYO-AI MCP exposes, so first-party chat plans to the family's
  // brief (trip_intent is owner-scoped, so the user client reads its own).
  const brief = briefText(await readIntent(client, tripId));

  // Cap + ledger use the service role: ai_jobs withholds insert from clients.
  const svc = serviceClient();
  await assertUnderCap(svc, tripId);
  const jobId = await startJob(svc, { userId, tripId, kind: 'chat', model: chatModel() });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse({ start: true, generated_by: chatGeneratedBy() }));
      try {
        for await (const delta of planChatDeltas({ destination, content, brief, messages })) {
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
  // Same family brief the chat and the MCP use, so a captured item is labelled
  // and placed to fit the family.
  const brief = briefText(await readIntent(client, tripId));

  const svc = serviceClient();
  await assertUnderCap(svc, tripId);
  const jobId = await startJob(svc, { userId, tripId, kind: 'ingestion' });

  try {
    const result = await runIngest({ destination, text, image, hint, content, brief });

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

const JOURNAL_COLUMNS = 'id, trip_id, profile_id, body, mood, stars, day_id, media_ref, created_at';

const MEDIA_BUCKET = 'trip-media';
const MEDIA_URL_TTL_SECONDS = 3600;

// Resolve stored media_ref ids to short-lived signed download URLs so the FE
// can display photos. The bucket is private, so we sign with the service role.
// Unresolvable ids are dropped rather than surfaced as broken links.
async function resolveMediaRefs(entries: Array<{ media_ref?: string[] | null }>): Promise<void> {
  const ids = [...new Set(entries.flatMap((e) => (Array.isArray(e.media_ref) ? e.media_ref : [])))];
  if (ids.length === 0) return;

  const svc = serviceClient();
  const { data: assets } = await svc.from('media_assets').select('id, path').in('id', ids);
  const urlById = new Map<string, string>();
  for (const a of assets ?? []) {
    const { data: signed } = await svc.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(a.path as string, MEDIA_URL_TTL_SECONDS);
    if (signed?.signedUrl) urlById.set(a.id as string, signed.signedUrl);
  }

  for (const e of entries) {
    if (Array.isArray(e.media_ref)) {
      e.media_ref = e.media_ref
        .map((id) => urlById.get(id))
        .filter((u): u is string => typeof u === 'string');
    }
  }
}

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
  const entries = (data ?? []) as Array<{ media_ref?: string[] | null }>;
  await resolveMediaRefs(entries);
  return json({ entries });
}

const CHAT_COLUMNS = 'id, role, kind, content, meta, seq, created_at';

// Reopenable planning-chat history. RLS scopes rows to the owner.
async function handleChatList(client: UserClient, tripId: string): Promise<Response> {
  const { data, error: dbErr } = await client
    .from('trip_chat_messages')
    .select(CHAT_COLUMNS)
    .eq('trip_id', tripId)
    .order('seq', { ascending: true })
    .order('created_at', { ascending: true });
  if (dbErr) throw new Error(dbErr.message);
  return json({ messages: data ?? [] });
}

// Persist trip content (the full object) as the caller. A connector-driven write
// (x-yaycay-source) is additionally capped, logged to ai_jobs, and queued for
// content review, like any external-model mutation. Returns the saved content.
async function persistContent(
  client: UserClient,
  userId: string,
  tripId: string,
  content: TripContent,
  req: Request,
): Promise<TripContent> {
  const { data: trip } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) throw new NotFoundError();

  const fromConnector = req.headers.get('x-yaycay-source') === 'connector';
  if (fromConnector) {
    const svc = serviceClient();
    await assertUnderCap(svc, tripId);
    const { data, error: dbErr } = await client
      .from('trip_content')
      .upsert({ trip_id: tripId, user_id: userId, content }, { onConflict: 'trip_id' })
      .select('content')
      .single();
    if (dbErr) throw new Error(dbErr.message);
    const jobId = await startJob(svc, {
      userId,
      tripId,
      kind: 'ingestion',
      model: 'byo',
      source: 'connector',
      connectorId: req.headers.get('x-yaycay-connector-id'),
      assistant: req.headers.get('x-yaycay-assistant'),
    });
    await finishJob(svc, jobId, 'succeeded');
    await svc
      .from('content_review')
      .upsert(
        { trip_id: tripId, status: 'pending', generated_at: new Date().toISOString() },
        { onConflict: 'trip_id' },
      );
    return data.content as TripContent;
  }

  const { data, error: dbErr } = await client
    .from('trip_content')
    .upsert({ trip_id: tripId, user_id: userId, content }, { onConflict: 'trip_id' })
    .select('content')
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return data.content as TripContent;
}

const INTENT_SELECT = 'pace, budget, travellers, interests, must_do, avoid, notes, constraints';

async function handleIntentGet(client: UserClient, tripId: string): Promise<Response> {
  return json({ intent: await readIntent(client, tripId) });
}

// Patch-write the trip brief: only the fields provided change; the rest are left
// as-is. This is the inbound path for what the family tells their assistant -
// allergies, dietary needs, must-dos, pace - so Yaycay remembers it.
async function handleIntentPut(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const { data: trip } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!trip) throw new NotFoundError();

  const body = await readJson(req);
  const existing = await readIntent(client, tripId);
  const patch: Record<string, unknown> = {};
  for (const f of INTENT_FIELDS) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (Object.keys(patch).length === 0) throw new ValidationError(['no intent fields provided']);

  const row = { trip_id: tripId, user_id: userId, ...(existing ?? {}), ...patch };
  const { data, error: dbErr } = await client
    .from('trip_intent')
    .upsert(row, { onConflict: 'trip_id' })
    .select(INTENT_SELECT)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json({ intent: data });
}

const COMPANION_COLUMNS = 'id, near_label, prompt, options, rain_plan, created_at';

// Pre-loaded "what's nearby" companion cards. RLS scopes rows to the owner.
async function handleCompanionList(client: UserClient, tripId: string): Promise<Response> {
  const { data, error: dbErr } = await client
    .from('trip_companion_cards')
    .select(COMPANION_COLUMNS)
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });
  if (dbErr) throw new Error(dbErr.message);
  return json({ cards: data ?? [] });
}

const RESERVATION_COLUMNS =
  'id, trip_id, kind, title, when_text, location, ref, status, notes, created_at, updated_at';
const RESERVATION_KINDS = ['hotel', 'activity', 'flight', 'transport', 'dining', 'other'];
const RESERVATION_STATUSES = ['planned', 'booked', 'confirmed', 'cancelled'];

// The family's track-and-confirm booking record (no payments). RLS scopes rows
// to the owner.
async function handleReservationsList(client: UserClient, tripId: string): Promise<Response> {
  const { data, error: dbErr } = await client
    .from('trip_reservations')
    .select(RESERVATION_COLUMNS)
    .eq('trip_id', tripId)
    .order('created_at', { ascending: true });
  if (dbErr) throw new Error(dbErr.message);
  return json({ reservations: data ?? [] });
}

async function handleReservationCreate(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const body = await readJson(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) throw new ValidationError(['title is required']);
  const kind =
    typeof body.kind === 'string' && RESERVATION_KINDS.includes(body.kind) ? body.kind : 'activity';
  const status =
    typeof body.status === 'string' && RESERVATION_STATUSES.includes(body.status)
      ? body.status
      : 'planned';
  const whenText =
    typeof body.when === 'string'
      ? body.when
      : typeof body.when_text === 'string'
        ? body.when_text
        : null;
  const { data, error: dbErr } = await client
    .from('trip_reservations')
    .insert({
      trip_id: tripId,
      user_id: userId,
      kind,
      title,
      when_text: whenText,
      location: typeof body.location === 'string' ? body.location : null,
      ref: typeof body.ref === 'string' ? body.ref : null,
      status,
      notes: typeof body.notes === 'string' ? body.notes : null,
    })
    .select(RESERVATION_COLUMNS)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json({ reservation: data });
}

async function handleReservationUpdate(
  client: UserClient,
  tripId: string,
  reservationId: string,
  req: Request,
): Promise<Response> {
  const body = await readJson(req);
  const patch: Record<string, unknown> = {};
  if (typeof body.status === 'string') {
    if (!RESERVATION_STATUSES.includes(body.status)) throw new ValidationError(['invalid status']);
    patch.status = body.status;
  }
  if (typeof body.kind === 'string') {
    if (!RESERVATION_KINDS.includes(body.kind)) throw new ValidationError(['invalid kind']);
    patch.kind = body.kind;
  }
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.when === 'string') patch.when_text = body.when;
  else if (typeof body.when_text === 'string') patch.when_text = body.when_text;
  for (const f of ['location', 'ref', 'notes'] as const) {
    if (typeof body[f] === 'string') patch[f] = body[f];
  }
  if (Object.keys(patch).length === 0) throw new ValidationError(['no fields to update']);
  const { data, error: dbErr } = await client
    .from('trip_reservations')
    .update(patch)
    .eq('id', reservationId)
    .eq('trip_id', tripId)
    .select(RESERVATION_COLUMNS)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  if (!data) throw new NotFoundError();
  return json({ reservation: data });
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
  const dayId = typeof body.day_id === 'string' ? body.day_id : null;
  const mood = typeof body.mood === 'string' ? body.mood : null;
  const mediaRef = Array.isArray(body.media_ref)
    ? (body.media_ref as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (text.trim().length === 0 && mediaRef.length === 0) {
    throw new ValidationError(['Provide body text or media_ref.']);
  }

  let stars: number | null = null;
  if (body.stars !== undefined && body.stars !== null) {
    const n = Number(body.stars);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new ValidationError(['stars must be an integer 1-5']);
    }
    stars = n;
  }

  const { data, error: dbErr } = await client
    .from('journal_entries')
    .insert({
      trip_id: tripId,
      user_id: userId,
      profile_id: profileId,
      day_id: dayId,
      body: text,
      mood,
      stars,
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

// Confirm the caller can see the trip (RLS); an unknown id becomes a clean 404.
async function ensureTripVisible(client: UserClient, tripId: string): Promise<void> {
  const { data } = await client.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (!data) throw new NotFoundError();
}

// ----- Per-explorer feature toggles -----------------------------------------

const FEATURE_COLUMNS = 'profile_id, overrides, updated_at';

function toFeatureRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    profile_id: (r.profile_id as string | null) ?? null,
    overrides:
      r.overrides && typeof r.overrides === 'object'
        ? (r.overrides as Record<string, unknown>)
        : {},
    updated_at: r.updated_at as string,
  };
}

// Store only boolean entries; the toggle vocabulary is open-ended by design, so
// absent keys fall back to the explorer's age-band default on the client.
function sanitiseOverrides(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

async function handleFeaturesGet(client: UserClient, tripId: string): Promise<Response> {
  await ensureTripVisible(client, tripId);
  const { data, error: dbErr } = await client
    .from('trip_profile_features')
    .select(FEATURE_COLUMNS)
    .eq('trip_id', tripId);
  if (dbErr) throw new Error(dbErr.message);
  return json({ features: (data ?? []).map((r) => toFeatureRow(r as Record<string, unknown>)) });
}

async function handleFeaturesPut(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  const body = await readJson(req);
  const profileId = typeof body.profile_id === 'string' ? body.profile_id : null;
  if (!profileId) throw new ValidationError(['profile_id is required']);
  const overrides = sanitiseOverrides(body.overrides);

  // Caller must own the trip (RLS) before writing toggles.
  await ensureTripVisible(client, tripId);

  const { data, error: dbErr } = await client
    .from('trip_profile_features')
    .upsert(
      {
        trip_id: tripId,
        user_id: userId,
        profile_id: profileId,
        overrides,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'trip_id,profile_id' },
    )
    .select(FEATURE_COLUMNS)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json(toFeatureRow(data as Record<string, unknown>));
}

// ----- Stars (reward economy) ------------------------------------------------

const STAR_COLUMNS = 'id, profile_id, source, day, stars, created_at';

async function handleStarsGet(client: UserClient, tripId: string, url: URL): Promise<Response> {
  await ensureTripVisible(client, tripId);
  let q = client
    .from('star_ledger')
    .select(STAR_COLUMNS)
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false });
  const profileId = url.searchParams.get('profile_id');
  if (profileId) q = q.eq('profile_id', profileId);
  const { data, error: dbErr } = await q;
  if (dbErr) throw new Error(dbErr.message);

  const entries = (data ?? []) as Array<Record<string, unknown>>;
  const balances = new Map<string, number>();
  for (const e of entries) {
    const pid = e.profile_id as string;
    balances.set(pid, (balances.get(pid) ?? 0) + Number(e.stars));
  }
  return json({
    balances: [...balances].map(([profile_id, stars]) => ({ profile_id, stars })),
    entries,
  });
}

async function handleStarsClaim(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  await ensureTripVisible(client, tripId);
  const body = await readJson(req);
  const profileId = typeof body.profile_id === 'string' ? body.profile_id : '';
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (!profileId) throw new ValidationError(['profile_id is required']);
  if (!source) throw new ValidationError(['source is required']);
  const day = typeof body.day === 'string' ? body.day : '';

  let stars = 1;
  if (body.stars !== undefined) {
    const n = Number(body.stars);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new ValidationError(['stars must be an integer 1-10']);
    }
    stars = n;
  }

  // Idempotent: a duplicate (trip, profile, day, source) is ignored, not doubled.
  const { error: insErr } = await client
    .from('star_ledger')
    .insert({ trip_id: tripId, user_id: userId, profile_id: profileId, source, day, stars });
  let claimed = true;
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') claimed = false;
    else throw new Error(insErr.message);
  }

  const { data: entry } = await client
    .from('star_ledger')
    .select(STAR_COLUMNS)
    .eq('trip_id', tripId)
    .eq('profile_id', profileId)
    .eq('day', day)
    .eq('source', source)
    .maybeSingle();

  const { data: rows } = await client
    .from('star_ledger')
    .select('stars')
    .eq('trip_id', tripId)
    .eq('profile_id', profileId);
  const balance = (rows ?? []).reduce((s, r) => s + Number((r as { stars: number }).stars), 0);

  return json({ claimed, entry, balance }, claimed ? 201 : 200);
}

// ----- Packing (per-trip document) -------------------------------------------
// One collection endpoint. GET returns { lists }; PATCH applies an action and
// returns the whole recomputed { lists }. Lists/sections are seeded by BE on
// first touch (a Family list + one per child profile, each with default
// sections); the FE adds items into them.

interface PackItem {
  id: string;
  label: string;
  qty?: number;
  checked: boolean;
}
interface PackSection {
  id: string;
  label: string;
  items: PackItem[];
}
interface PackList {
  id: string;
  label: string;
  sections: PackSection[];
}

const DEFAULT_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'clothes', label: 'Clothes' },
  { id: 'toiletries', label: 'Toiletries' },
  { id: 'essentials', label: 'Essentials' },
  { id: 'activities', label: 'Activities' },
];

function seedSections(): PackSection[] {
  return DEFAULT_SECTIONS.map((s) => ({ id: s.id, label: s.label, items: [] }));
}

// Default lists: a Family list plus one per child profile (id = profile id).
async function seedLists(client: UserClient): Promise<PackList[]> {
  const { data } = await client
    .from('child_profiles')
    .select('id, name')
    .order('created_at', { ascending: true });
  const lists: PackList[] = [{ id: 'family', label: 'Family', sections: seedSections() }];
  for (const p of (data ?? []) as Array<{ id: string; name: string }>) {
    lists.push({ id: p.id, label: p.name, sections: seedSections() });
  }
  return lists;
}

// Current lists for a trip: the stored document, else a freshly seeded skeleton
// (deterministic ids, so a later PATCH that persists matches what GET returned).
async function computeLists(client: UserClient, tripId: string): Promise<PackList[]> {
  const { data, error: dbErr } = await client
    .from('trip_packing')
    .select('lists')
    .eq('trip_id', tripId)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  const existing = data?.lists as PackList[] | undefined;
  if (existing && existing.length > 0) return existing;
  return await seedLists(client);
}

function findItem(lists: PackList[], listId: string, itemId: string): PackItem | undefined {
  const list = lists.find((l) => l.id === listId);
  if (!list) return undefined;
  for (const s of list.sections) {
    const it = s.items.find((i) => i.id === itemId);
    if (it) return it;
  }
  return undefined;
}

async function handlePackingGet(client: UserClient, tripId: string): Promise<Response> {
  await ensureTripVisible(client, tripId);
  return json({ lists: await computeLists(client, tripId) });
}

async function handlePackingPatch(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  await ensureTripVisible(client, tripId);
  const body = await readJson(req);
  const action = typeof body.action === 'string' ? body.action : '';
  const lists = await computeLists(client, tripId);

  switch (action) {
    case 'tick': {
      const listId = typeof body.list_id === 'string' ? body.list_id : '';
      const itemId = typeof body.item_id === 'string' ? body.item_id : '';
      if (!listId || !itemId) throw new ValidationError(['list_id and item_id are required']);
      const item = findItem(lists, listId, itemId);
      if (!item) throw new NotFoundError();
      item.checked = body.checked === true;
      break;
    }
    case 'add': {
      const listId = typeof body.list_id === 'string' ? body.list_id : '';
      const sectionId = typeof body.section_id === 'string' ? body.section_id : '';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!listId || !sectionId) throw new ValidationError(['list_id and section_id are required']);
      if (!label) throw new ValidationError(['label is required']);
      const section = lists.find((l) => l.id === listId)?.sections.find((s) => s.id === sectionId);
      if (!section) throw new NotFoundError();
      const item: PackItem = { id: crypto.randomUUID(), label, checked: false };
      if (body.qty !== undefined && body.qty !== null) {
        const n = Number(body.qty);
        if (!Number.isInteger(n) || n < 1) {
          throw new ValidationError(['qty must be a positive integer']);
        }
        item.qty = n;
      }
      section.items.push(item);
      break;
    }
    case 'delete': {
      const listId = typeof body.list_id === 'string' ? body.list_id : '';
      const itemId = typeof body.item_id === 'string' ? body.item_id : '';
      if (!listId || !itemId) throw new ValidationError(['list_id and item_id are required']);
      const list = lists.find((l) => l.id === listId);
      if (!list) throw new NotFoundError();
      let removed = false;
      for (const s of list.sections) {
        const before = s.items.length;
        s.items = s.items.filter((it) => it.id !== itemId);
        if (s.items.length !== before) removed = true;
      }
      if (!removed) throw new NotFoundError();
      break;
    }
    case 'reset': {
      // Trip-wide: clear every tick across all lists.
      for (const l of lists) {
        for (const s of l.sections) for (const it of s.items) it.checked = false;
      }
      break;
    }
    default:
      throw new ValidationError(['action must be tick|add|delete|reset']);
  }

  const { error: dbErr } = await client
    .from('trip_packing')
    .upsert(
      { trip_id: tripId, user_id: userId, lists, updated_at: new Date().toISOString() },
      { onConflict: 'trip_id' },
    );
  if (dbErr) throw new Error(dbErr.message);
  return json({ lists });
}

// ----- Grown-ups checklist ---------------------------------------------------

const CHECKLIST_COLUMNS = 'item, checked, updated_at';

async function handleChecklistGet(client: UserClient, tripId: string): Promise<Response> {
  await ensureTripVisible(client, tripId);
  const { data, error: dbErr } = await client
    .from('grownups_checklist')
    .select(CHECKLIST_COLUMNS)
    .eq('trip_id', tripId)
    .order('item', { ascending: true });
  if (dbErr) throw new Error(dbErr.message);
  return json({ items: data ?? [] });
}

async function handleChecklistUpdate(
  client: UserClient,
  userId: string,
  tripId: string,
  req: Request,
): Promise<Response> {
  await ensureTripVisible(client, tripId);
  const body = await readJson(req);

  // Accept a single {item, checked} or a batch {items: [...]}.
  const items: Array<{ item: string; checked: boolean }> = [];
  if (Array.isArray(body.items)) {
    for (const it of body.items as unknown[]) {
      const o = (it ?? {}) as Record<string, unknown>;
      if (typeof o.item === 'string') items.push({ item: o.item, checked: o.checked === true });
    }
  } else if (typeof body.item === 'string') {
    items.push({ item: body.item, checked: body.checked === true });
  }
  if (items.length === 0) throw new ValidationError(['Provide item + checked, or items[].']);

  const rows = items.map((i) => ({
    trip_id: tripId,
    user_id: userId,
    item: i.item,
    checked: i.checked,
    updated_at: new Date().toISOString(),
  }));
  const { error: dbErr } = await client
    .from('grownups_checklist')
    .upsert(rows, { onConflict: 'trip_id,item' });
  if (dbErr) throw new Error(dbErr.message);
  return handleChecklistGet(client, tripId);
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
