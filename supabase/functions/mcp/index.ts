// POST /mcp - the authenticated BYO-AI MCP endpoint (gateway verify_jwt=false).
//
// Auth is a connector token (Authorization: Bearer <token>), not a Supabase JWT.
// The token is verified and its connector row resolved (must be active); every
// tool is scoped to that connector's single trip. Writes reuse the shared
// TripContentPatch apply path and are re-validated against the schema. No
// model is called here (the parent's own AI drives the tools), so there is no
// cost to us; each write is logged to ai_jobs for the audit trail.
//
// The endpoint is self-describing: initialize returns Yaycay's content model and
// planning philosophy as `instructions`, and get_trip_brief surfaces the trip's
// intent (the "why" - travellers, pace, must-dos) so the external assistant plans
// with context, not just raw structure. Intent is captured in trip_intent and
// shared with Yaycay's own curation; serving/curation stays first-party (off the
// MCP) - see docs/handoff/MCP-CONTEXT-AND-INTENT.md.

import { json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { verifyToken, TokenError } from '../_shared/mcp-token.ts';
import { applyPatch, PatchError, type TripContentPatch } from '../_shared/trip-patch.ts';
import { validateTripContent } from '../_shared/trip-content-validate.ts';
import type { TripContent } from '../_shared/content-types.ts';
import { startJob, finishJob } from '../_shared/ai-jobs.ts';
import { INTENT_FIELDS, readIntent, type TripIntent } from '../_shared/trip-intent.ts';

const SERVER_INFO = { name: 'yaycay-byo-ai', version: '1.0.0' };
const EMPTY: TripContent = { trip: {} as TripContent['trip'], days: [] };

// Returned from `initialize` so the connecting assistant understands Yaycay
// before it touches a tool: the content model, the planning philosophy, and how
// to use the tools well. Keep it short and stable - it frames every later call.
const INSTRUCTIONS = [
  'You are helping plan a family holiday in Yaycay.',
  '',
  'Content model: a Holiday has Days; each Day has Moments (time-of-day blocks:',
  'morning, midday, afternoon, evening, night, anytime); each Moment has',
  'Activities. An Activity has a kind: "kid", "shared", or "adult".',
  '',
  "Start with get_trip_brief to learn the family's intent (who is travelling,",
  'their ages and interests, the pace and budget they want, must-dos and no-gos).',
  'Plan to that brief, not to generic ideas. If you learn something new about what',
  'the family wants, record it with set_trip_brief so Yaycay remembers it.',
  '',
  'Planning philosophy: age-appropriate and realistically paced - a few good',
  'Moments a day beat an over-stuffed schedule. Respect nap windows and stated',
  'constraints. Balance kid, shared, and adult activities. Honour avoid/no-gos.',
  '',
  'Use list_days to see structure, get_trip to read full content, then the',
  'add/update/move tools to build the itinerary.',
].join('\n');

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; required?: string[]; properties: Record<string, unknown> };
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_trip_brief',
    description:
      "Read the trip BRIEF: the family's intent (travellers and ages, interests, " +
      'pace, budget, must-dos, no-gos, constraints) plus destination and dates. ' +
      'Call this first - plan to the brief, not to generic ideas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_trip_brief',
    description:
      'Record or refine the trip brief when you learn what the family wants. ' +
      'Only the fields you pass are updated; omit a field to leave it unchanged. ' +
      'Stored as first-class intent and reused by Yaycay beyond this assistant.',
    inputSchema: {
      type: 'object',
      properties: {
        pace: { type: 'string', enum: ['relaxed', 'balanced', 'packed'] },
        budget: { type: 'string', enum: ['budget', 'moderate', 'premium', 'splurge'] },
        travellers: { type: 'array', items: { type: 'object' } },
        interests: { type: 'array', items: { type: 'string' } },
        must_do: { type: 'array', items: { type: 'string' } },
        avoid: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        constraints: { type: 'object' },
      },
    },
  },
  {
    name: 'get_trip',
    description: 'Read the full trip content (Holiday -> Days -> Moments -> Activities).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_days',
    description: 'List the days with their moments (ids, slots, titles).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_moment',
    description: 'Add a moment to a day.',
    inputSchema: {
      type: 'object',
      required: ['day_id', 'moment'],
      properties: { day_id: { type: 'string' }, moment: { type: 'object' } },
    },
  },
  {
    name: 'add_activity',
    description: 'Add an activity to a moment.',
    inputSchema: {
      type: 'object',
      required: ['day_id', 'moment_id', 'activity'],
      properties: {
        day_id: { type: 'string' },
        moment_id: { type: 'string' },
        activity: { type: 'object' },
      },
    },
  },
  {
    name: 'update_activity',
    description: 'Update fields of an activity.',
    inputSchema: {
      type: 'object',
      required: ['activity_id', 'set'],
      properties: { activity_id: { type: 'string' }, set: { type: 'object' } },
    },
  },
  {
    name: 'move_activity',
    description: 'Move an activity to another moment.',
    inputSchema: {
      type: 'object',
      required: ['activity_id', 'to_moment_id'],
      properties: { activity_id: { type: 'string' }, to_moment_id: { type: 'string' } },
    },
  },
  {
    name: 'set_packing_list',
    description: 'Set the grown-ups packing checklist.',
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'import_reservation',
    description: 'Record a booking as an activity on a day/moment.',
    inputSchema: {
      type: 'object',
      required: ['day_id', 'name'],
      properties: {
        day_id: { type: 'string' },
        moment_id: { type: 'string' },
        name: { type: 'string' },
        time: { type: 'string' },
        ref: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'optimise_day',
    description: 'Reorder a day’s moments by time of day.',
    inputSchema: {
      type: 'object',
      required: ['day_id'],
      properties: { day_id: { type: 'string' } },
    },
  },
];

const SLOT_ORDER = ['morning', 'midday', 'afternoon', 'evening', 'night', 'anytime'];

interface Ctx {
  uid: string;
  tid: string;
  /** Tool-name scopes granted to this connector (per-tool authorisation). */
  scopes: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  if (req.method !== 'POST') return rpcError(null, -32600, 'Use POST.');

  // ----- Auth: connector token -----
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return rpcError(null, -32001, 'Missing connector token.', 401);

  let ctx: Ctx;
  try {
    const claims = await verifyToken(token);
    const db = serviceClient();
    const { data: connector } = await db
      .from('connectors')
      .select('id, user_id, trip_id, revoked_at, scopes')
      .eq('id', claims.cid)
      .maybeSingle();
    if (!connector || connector.revoked_at || connector.trip_id !== claims.tid) {
      return rpcError(null, -32001, 'Connector is not active.', 401);
    }
    await db
      .from('connectors')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', claims.cid);
    ctx = { uid: claims.uid, tid: claims.tid, scopes: (connector.scopes as string[]) ?? [] };
  } catch (err) {
    if (err instanceof TokenError) return rpcError(null, -32001, 'Invalid connector token.', 401);
    console.error('mcp auth error', err);
    return rpcError(null, -32603, 'Internal error.', 500);
  }

  // ----- JSON-RPC -----
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error.');
  }
  const { id, method } = msg;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    return rpcResult(id ?? null, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // Per-tool authorisation: the tool must be in the connector's granted
    // scopes. Connectors are minted with CONNECTOR_DEFAULT_SCOPES, so today this
    // covers all tools - but a narrower grant is now enforced here, not merely
    // advisory in the manifest.
    if (!ctx.scopes.includes(name)) {
      return rpcError(id, -32002, `Connector is not scoped for tool: ${name}`);
    }
    try {
      const text = await callTool(ctx, name, args);
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id ?? null, -32601, `Method not found: ${method}`);
});

async function readContent(tid: string): Promise<TripContent> {
  const { data } = await serviceClient()
    .from('trip_content')
    .select('content')
    .eq('trip_id', tid)
    .maybeSingle();
  return (data?.content as TripContent) ?? EMPTY;
}

// The trip brief: the "why" behind the trip. get_trip_brief assembles intent
// (from the shared trip-intent module) with the trip header and a child-profile
// seed so the assistant plans with context; set_trip_brief patch-writes intent.
async function readBrief(ctx: Ctx): Promise<string> {
  const db = serviceClient();
  const [{ data: trip }, intent, { data: children }] = await Promise.all([
    db
      .from('trips')
      .select('destination, start_date, end_date, tier, status')
      .eq('id', ctx.tid)
      .maybeSingle(),
    readIntent(db, ctx.tid),
    db
      .from('child_profiles')
      // Minimised seed for an external assistant: low-sensitivity planning
      // fields only. Children's health data (dietary/medical) is deliberately
      // NOT exported off-platform here; if the family wants it considered, they
      // convey it per-trip via set_trip_brief (intent.constraints), which they
      // control. The trip-scoped intent.travellers is the authoritative roster.
      .select('name, age, mode, interests')
      .eq('user_id', ctx.uid),
  ]);
  return JSON.stringify({
    trip: trip ?? null,
    // Low-sensitivity seed (no dietary/medical) the family can promote into the
    // trip's travellers via set_trip_brief.
    child_profiles: children ?? [],
    intent,
    note: intent
      ? undefined
      : 'No brief captured yet. Ask the family about pace, interests, must-dos, ' +
        'and who is travelling, then record it with set_trip_brief.',
  });
}

async function writeBrief(ctx: Ctx, a: Record<string, unknown>): Promise<string> {
  // Patch semantics: only the provided fields are written, the rest are left as
  // they are. We merge over the existing row so an omitted field is untouched.
  const db = serviceClient();
  const existing = await readIntent(db, ctx.tid);

  const patch: TripIntent = {};
  for (const f of INTENT_FIELDS) {
    if (a[f] !== undefined) (patch as Record<string, unknown>)[f] = a[f];
  }

  const row = {
    trip_id: ctx.tid,
    user_id: ctx.uid,
    ...(existing ?? {}),
    ...patch,
  };
  const { error: dbErr } = await db.from('trip_intent').upsert(row, { onConflict: 'trip_id' });
  if (dbErr) throw new Error(dbErr.message);
  const changed = Object.keys(patch);
  return changed.length ? `Brief updated (${changed.join(', ')}).` : 'No brief fields to update.';
}

// Apply a mutation, re-validate, persist, and log the BYO write. Returns a short
// confirmation string for the tool result.
async function mutate(ctx: Ctx, next: TripContent, summary: string): Promise<string> {
  const errors = validateTripContent(next);
  if (errors.length > 0) throw new Error(`Invalid result: ${errors.join('; ')}`);
  const db = serviceClient();
  const { error: dbErr } = await db
    .from('trip_content')
    .upsert({ trip_id: ctx.tid, user_id: ctx.uid, content: next }, { onConflict: 'trip_id' });
  if (dbErr) throw new Error(dbErr.message);
  const jobId = await startJob(db, {
    userId: ctx.uid,
    tripId: ctx.tid,
    kind: 'ingestion',
    model: 'byo',
    source: 'connector',
  });
  await finishJob(db, jobId, 'succeeded');
  // External (BYO) content has no guardrail of ours, so it must still hit the
  // review bar: (re-)flag the trip for content review.
  await db
    .from('content_review')
    .upsert(
      { trip_id: ctx.tid, status: 'pending', generated_at: new Date().toISOString() },
      { onConflict: 'trip_id' },
    );
  return summary;
}

async function applyOps(ctx: Ctx, patch: TripContentPatch, summary: string): Promise<string> {
  const content = await readContent(ctx.tid);
  let next: TripContent;
  try {
    next = applyPatch(content, patch);
  } catch (err) {
    if (err instanceof PatchError) throw new Error(err.message);
    throw err;
  }
  return mutate(ctx, next, summary);
}

async function callTool(ctx: Ctx, name: string, a: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_trip_brief':
      return readBrief(ctx);
    case 'set_trip_brief':
      return writeBrief(ctx, a);
    case 'get_trip':
      return JSON.stringify(await readContent(ctx.tid));
    case 'list_days': {
      const c = await readContent(ctx.tid);
      const days = (c.days ?? []).map((d) => ({
        id: d.id,
        date: d.date,
        label: d.label,
        moments: (d.moments ?? []).map((m) => ({ id: m.id, slot: m.slot, title: m.title })),
      }));
      return JSON.stringify({ days });
    }
    case 'add_moment':
      return applyOps(
        ctx,
        { ops: [{ op: 'add_moment', day_id: a.day_id as string, moment: a.moment as never }] },
        'Moment added.',
      );
    case 'add_activity':
      return applyOps(
        ctx,
        {
          ops: [
            {
              op: 'add_activity',
              day_id: a.day_id as string,
              moment_id: a.moment_id as string,
              activity: a.activity as never,
            },
          ],
        },
        'Activity added.',
      );
    case 'update_activity':
      return applyOps(
        ctx,
        {
          ops: [
            { op: 'update_activity', activity_id: a.activity_id as string, set: a.set as never },
          ],
        },
        'Activity updated.',
      );
    case 'move_activity':
      return applyOps(
        ctx,
        {
          ops: [
            {
              op: 'move_activity',
              activity_id: a.activity_id as string,
              to_moment_id: a.to_moment_id as string,
            },
          ],
        },
        'Activity moved.',
      );
    case 'import_reservation': {
      const activity = {
        id: '',
        kind: 'shared' as const,
        title: (a.name as string) ?? 'Booking',
        booking: {
          name: (a.name as string) ?? 'Booking',
          time: typeof a.time === 'string' ? a.time : undefined,
          ref: typeof a.ref === 'string' ? a.ref : undefined,
          notes: typeof a.notes === 'string' ? a.notes : undefined,
        },
      };
      if (typeof a.moment_id === 'string') {
        return applyOps(
          ctx,
          {
            ops: [
              { op: 'add_activity', day_id: a.day_id as string, moment_id: a.moment_id, activity },
            ],
          },
          'Reservation imported.',
        );
      }
      return applyOps(
        ctx,
        {
          ops: [
            {
              op: 'add_moment',
              day_id: a.day_id as string,
              moment: {
                id: '',
                slot: 'anytime',
                title: 'Bookings',
                activities: [activity],
              } as never,
            },
          ],
        },
        'Reservation imported.',
      );
    }
    case 'set_packing_list': {
      const items = Array.isArray(a.items)
        ? (a.items as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const content = await readContent(ctx.tid);
      const next: TripContent = {
        ...content,
        grownups: { ...(content.grownups ?? {}), checklist: items },
      };
      return mutate(ctx, next, `Packing list set (${items.length} items).`);
    }
    case 'optimise_day': {
      const content = await readContent(ctx.tid);
      const next: TripContent = structuredClone(content);
      const day = next.days.find((d) => d.id === a.day_id);
      if (!day) throw new Error(`No day with id ${a.day_id}`);
      day.moments.sort((x, y) => SLOT_ORDER.indexOf(x.slot) - SLOT_ORDER.indexOf(y.slot));
      return mutate(ctx, next, 'Day optimised.');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
