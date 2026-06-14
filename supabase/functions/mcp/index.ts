// POST /mcp - the authenticated BYO-AI MCP endpoint (gateway verify_jwt=false).
//
// Auth is a connector token (Authorization: Bearer <token>), not a Supabase JWT.
// The token is verified and its connector row resolved (must be active); every
// tool is scoped to that connector's single trip. Writes reuse the shared
// TripContentPatch apply path and are re-validated against the schema. No
// model is called here (the parent's own AI drives the tools), so there is no
// cost to us; each write is logged to ai_jobs for the audit trail.

import { json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { McpAuthError, verifyMcpToken } from '../_shared/mcp-auth.ts';
import { applyPatch, PatchError, type TripContentPatch } from '../_shared/trip-patch.ts';
import { validateTripContent } from '../_shared/trip-content-validate.ts';
import type { TripContent } from '../_shared/content-types.ts';
import { finishJob, startJob } from '../_shared/ai-jobs.ts';

const SERVER_INFO = { name: 'yaycay-byo-ai', version: '1.0.0' };
const EMPTY: TripContent = { trip: {} as TripContent['trip'], days: [] };

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

// Account-scoped (OAuth) tokens are not bound to a single trip, so every tool
// also accepts an optional `trip_id`. Connector tokens ignore it (their trip is
// fixed by the token). Injected once so the two auth models share one surface.
for (const t of TOOLS) {
  t.inputSchema.properties = { trip_id: { type: 'string' }, ...t.inputSchema.properties };
}

interface Ctx {
  uid: string;
  tid: string;
}

// Resolve the trip a tool call should act on. Connector tokens carry it; an
// account-scoped grant must name it via `trip_id`, and we confirm it belongs to
// the grant's user before acting (the grant is account-wide, not a blank cheque
// on trips that are not theirs).
async function resolveTrip(ctx: Ctx, a: Record<string, unknown>): Promise<Ctx> {
  if (ctx.tid) return ctx;
  const tid = typeof a.trip_id === 'string' ? a.trip_id : '';
  if (!tid) throw new Error('trip_id is required for account-scoped tokens.');
  const { data: trip } = await serviceClient()
    .from('trips')
    .select('id')
    .eq('id', tid)
    .eq('user_id', ctx.uid)
    .maybeSingle();
  if (!trip) throw new Error('Trip not found for this account.');
  return { uid: ctx.uid, tid };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  if (req.method !== 'POST') return rpcError(null, -32600, 'Use POST.');

  // ----- Auth: connector token OR OAuth grant access token -----
  // verifyMcpToken dual-accepts both and resolves to { user, scopes, trip? }.
  // A connector token is bound to one trip (ctx.tid is fixed); an account-scoped
  // OAuth grant is not, so the trip is resolved per tool call from `trip_id`.
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return rpcError(null, -32001, 'Missing access token.', 401);

  let ctx: Ctx;
  try {
    const resolved = await verifyMcpToken(token, serviceClient());
    ctx = { uid: resolved.user, tid: resolved.trip ?? '' };
  } catch (err) {
    if (err instanceof McpAuthError) return rpcError(null, -32001, err.message, 401);
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
  });
  await finishJob(db, jobId, 'succeeded');
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

async function callTool(rawCtx: Ctx, name: string, a: Record<string, unknown>): Promise<string> {
  const ctx = await resolveTrip(rawCtx, a);
  switch (name) {
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
