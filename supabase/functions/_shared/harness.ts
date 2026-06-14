// Model-agnostic AI harness.
//
// Phase 0 shipped the free-demo day generator; Phase 1 adds the two use-our-AI
// surfaces: a streaming planning chat and structured ingestion (a receipt,
// booking, or note becomes a TripContentPatch). All default to Claude Sonnet
// (the use-our-AI tier model), are driven by config where Admin has set a
// prompt/model, and fall back to a deterministic path when no API key is
// configured, so the demo, ingestion, and smoke tests always produce valid
// output without a live model.

import { optionalEnv } from './env.ts';
import type {
  Activity,
  Challenge,
  Day,
  ExplorerMode,
  Moment,
  Safety,
  StarChallenge,
  TripContent,
  Variants,
} from './content-types.ts';
import type { TripContentPatch } from './trip-patch.ts';

export interface DemoChildInput {
  name: string;
  age?: number;
  mode?: ExplorerMode;
  interests?: string[];
  dietary?: string[];
}

export interface DemoDayInput {
  destination: string;
  date?: string;
  child: DemoChildInput;
}

export interface DemoDayResult {
  day: Day;
  grownups_teaser: string;
  generated_by: 'ai' | 'fallback';
}

// Default model for the use-our-AI tier is Claude Sonnet.
const DEFAULT_MODEL = optionalEnv('DEMO_MODEL') ?? 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ----- AI observability ------------------------------------------------------
// Every AI surface (demo, chat, ingest) logs the same three things so a call is
// traceable in the Supabase Edge function logs: that it started (which model),
// how it ended (ai vs fallback), and - on failure - why it fell back. The
// failure path carries the thrown error, which now includes the Anthropic
// response body (invalid key, unknown model, no credit), so a misconfigured
// project is diagnosable from the logs instead of looking like "no key".
type AiSurface = 'demo' | 'chat' | 'ingest';

function logAiStart(surface: AiSurface, model: string): void {
  console.log(`[ai:${surface}] calling model=${model}`);
}

function logAiResult(surface: AiSurface, generatedBy: 'ai' | 'fallback'): void {
  console.log(`[ai:${surface}] done generated_by=${generatedBy}`);
}

/** No model call was attempted (missing key or nothing to send); served fallback. */
function logAiSkipped(surface: AiSurface, reason: string): void {
  console.log(`[ai:${surface}] no model call (${reason}); serving fallback`);
}

/** A model call threw; the surface degraded to its deterministic fallback. */
export function logAiError(surface: AiSurface, err: unknown): void {
  console.error(`[ai:${surface}] model call failed, using fallback:`, err);
}

export async function generateDemoDay(input: DemoDayInput): Promise<DemoDayResult> {
  const apiKey = optionalEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    logAiSkipped('demo', 'no ANTHROPIC_API_KEY');
    return { ...buildFallbackDay(input), generated_by: 'fallback' };
  }

  logAiStart('demo', DEFAULT_MODEL);
  try {
    const day = await generateWithClaude(input, apiKey);
    logAiResult('demo', 'ai');
    return {
      day,
      grownups_teaser: grownupsTeaser(input),
      generated_by: 'ai',
    };
  } catch (err) {
    // Never fail the demo on a model hiccup; degrade to the deterministic day.
    logAiError('demo', err);
    return { ...buildFallbackDay(input), generated_by: 'fallback' };
  }
}

// Tool schema for the demo day. The model fills this rather than free-typing
// JSON, so the API guarantees the returned `input` is syntactically valid JSON -
// no more brittle text parsing that breaks on a missing comma. The schema mirrors
// the rich content model (per-mode variants, facts, typed challenge, did_you_know,
// allergy safety) so the model produces everything the FE renders; normaliseDay
// does the final coercion.
const VARIANT_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: 'Activity copy pitched at this mode.' },
    fact: { type: 'string', description: 'A fun, true, destination-specific fact.' },
    quiz: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        a: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const CHALLENGE_SCHEMA = {
  type: 'object',
  description: 'A typed mini-challenge for the child.',
  properties: {
    type: { type: 'string', enum: ['quiz', 'spot', 'photo', 'challenge'] },
    prompt: { type: 'string' },
    answer: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    stars: { type: 'number', description: 'Stars earned (1-3).' },
  },
  required: ['type', 'prompt'],
};

const DAY_TOOL = {
  name: 'build_day',
  description: 'Return one delightful, destination-specific holiday day for the family.',
  input_schema: {
    type: 'object',
    required: ['summary', 'did_you_know', 'moments'],
    properties: {
      id: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      label: { type: 'string', description: 'Short day title, e.g. "A day in Kyoto".' },
      summary: { type: 'string', description: 'One warm sentence framing the day.' },
      did_you_know: {
        type: 'string',
        description: 'A surprising, true, kid-friendly fact about the destination.',
      },
      star_challenge: {
        type: 'object',
        description: "The day's headline star challenge for the child.",
        properties: {
          title: { type: 'string' },
          prompt: { type: 'string' },
          stars: { type: 'number' },
        },
        required: ['title'],
      },
      moments: {
        type: 'array',
        description: '3-4 moments across the day.',
        items: {
          type: 'object',
          required: ['title', 'activities'],
          properties: {
            id: { type: 'string' },
            slot: {
              type: 'string',
              enum: ['morning', 'midday', 'afternoon', 'evening', 'night', 'anytime'],
            },
            title: { type: 'string' },
            time_hint: { type: 'string', description: 'HH:MM' },
            location: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                lat: { type: 'number' },
                lng: { type: 'number' },
                zoom: { type: 'number' },
              },
            },
            activities: {
              type: 'array',
              description: '1-2 activities per moment.',
              items: {
                type: 'object',
                required: ['kind', 'title'],
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', enum: ['kid', 'shared', 'adult'] },
                  title: { type: 'string' },
                  body: { type: 'string' },
                  facts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '1-3 true, destination-specific facts a child would love.',
                  },
                  challenge: CHALLENGE_SCHEMA,
                  variants: {
                    type: 'object',
                    description:
                      'Keyed by explorer mode (little|standard|explorer|explorer_plus); each value tailors copy/fact/quiz to that mode.',
                    properties: {
                      little: VARIANT_SCHEMA,
                      standard: VARIANT_SCHEMA,
                      explorer: VARIANT_SCHEMA,
                      explorer_plus: VARIANT_SCHEMA,
                    },
                  },
                  safety: {
                    type: 'object',
                    properties: {
                      note: { type: 'string' },
                      flags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

async function generateWithClaude(input: DemoDayInput, apiKey: string): Promise<Day> {
  const mode = input.child.mode ?? 'explorer';
  const system =
    'You build a single delightful holiday day for a family travel app called Yaycay. ' +
    'Call the build_day tool. Make everything specific to the destination - real places, ' +
    'real local detail, never generic filler. The day has 3-4 moments, each with 1-2 ' +
    'activities. Use kind "kid" for child activities and "adult" for grown-up ones. ' +
    `Tailor each kid activity to the child's explorer mode ("${mode}"): set a variants block ` +
    'with at least that mode, giving a destination-specific fun fact and a single quiz. Add ' +
    '1-3 true "facts" and one typed "challenge" (quiz/spot/photo/challenge) to kid ' +
    'activities. Set the day "did_you_know" to a surprising local fact and a "star_challenge" ' +
    'for the child. If the child has dietary or medical flags, surface them as an activity ' +
    'safety note and flags. Keep copy warm and sunny. No em-dashes.';

  const data = await callAnthropicTool(apiKey, {
    system,
    maxTokens: 4096,
    tool: DAY_TOOL,
    content: `Build one day for this family:\n${
      JSON.stringify(
        { destination: input.destination, date: input.date, child: input.child },
        null,
        2,
      )
    }`,
    surface: 'demo',
  });
  return normaliseDay(data, input);
}

// Shared Anthropic tool-call: forces the given tool and returns its input
// object (already valid JSON). Throws with the response body / stop reason on
// failure, so the caller's logAiError surfaces a usable diagnosis.
async function callAnthropicTool(
  apiKey: string,
  opts: {
    system: string;
    maxTokens: number;
    tool: { name: string; description: string; input_schema: unknown };
    content: unknown[] | string;
    surface: AiSurface;
  },
): Promise<unknown> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: [opts.tool],
      tool_choice: { type: 'tool', name: opts.tool.name },
      messages: [{ role: 'user', content: opts.content }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${opts.surface} request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const toolUse = blocks.find(
    (b: Record<string, unknown>) => b?.type === 'tool_use' && b?.name === opts.tool.name,
  );
  if (!toolUse) {
    // A forced tool_choice should always return a tool_use block; if it did not,
    // the stop reason explains why (e.g. max_tokens truncated the call).
    throw new Error(
      `Anthropic ${opts.surface}: no ${opts.tool.name} tool_use in response (stop_reason=${data?.stop_reason})`,
    );
  }
  return (toolUse as { input: unknown }).input;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

// Coerce model output into a well-formed Day, filling required ids/fields and
// carrying through the rich fields (did_you_know, star_challenge, location,
// facts, typed challenge, per-mode variants, allergy safety) so the FE renders
// the full experience, not a stripped-down day.
function normaliseDay(raw: unknown, input: DemoDayInput): Day {
  const r = (raw ?? {}) as Record<string, unknown>;
  const moments = Array.isArray(r.moments) ? r.moments : [];
  const day: Day = {
    id: typeof r.id === 'string' ? r.id : 'd_demo',
    date: typeof r.date === 'string' ? r.date : input.date,
    label: typeof r.label === 'string' ? r.label : `A day in ${input.destination}`,
    summary: typeof r.summary === 'string' ? r.summary : undefined,
    did_you_know: typeof r.did_you_know === 'string' ? r.did_you_know : undefined,
    star_challenge: isRecord(r.star_challenge)
      ? (r.star_challenge as unknown as StarChallenge)
      : undefined,
    moments: moments.map((m, mi) => {
      const mm = (m ?? {}) as Record<string, unknown>;
      const acts = Array.isArray(mm.activities) ? mm.activities : [];
      return {
        id: typeof mm.id === 'string' ? mm.id : `m_${mi + 1}`,
        slot: isSlot(mm.slot) ? mm.slot : 'anytime',
        title: typeof mm.title === 'string' ? mm.title : `Moment ${mi + 1}`,
        time_hint: typeof mm.time_hint === 'string' ? mm.time_hint : undefined,
        location: isRecord(mm.location) && typeof mm.location.name === 'string'
          ? (mm.location as Moment['location'])
          : undefined,
        activities: acts.map((a, ai) => {
          const aa = (a ?? {}) as Record<string, unknown>;
          return {
            id: typeof aa.id === 'string' ? aa.id : `a_${mi + 1}_${ai + 1}`,
            kind: aa.kind === 'kid' || aa.kind === 'shared' || aa.kind === 'adult'
              ? aa.kind
              : 'shared',
            title: typeof aa.title === 'string' ? aa.title : 'Activity',
            body: typeof aa.body === 'string' ? aa.body : undefined,
            facts: stringArray(aa.facts),
            challenge: isRecord(aa.challenge) ? (aa.challenge as unknown as Challenge) : undefined,
            variants: isRecord(aa.variants) ? (aa.variants as Variants) : undefined,
            safety: isRecord(aa.safety) ? (aa.safety as Safety) : undefined,
          };
        }),
      };
    }),
  };
  return day.moments.length > 0 ? day : buildFallbackDay(input).day;
}

function isSlot(v: unknown): v is Day['moments'][number]['slot'] {
  return (
    v === 'morning' ||
    v === 'midday' ||
    v === 'afternoon' ||
    v === 'evening' ||
    v === 'night' ||
    v === 'anytime'
  );
}

// ----- Deterministic fallback ------------------------------------------------

function grownupsTeaser(input: DemoDayInput): string {
  const flags = input.child.dietary?.length
    ? ` We will flag ${input.child.name}'s dietary needs at every booking.`
    : '';
  return (
    `The full grown-ups guide turns this into a calm plan: transport, timings, ` +
    `bookings and a packing checklist for your trip to ${input.destination}.${flags}`
  );
}

export function buildFallbackDay(input: DemoDayInput): Omit<DemoDayResult, 'generated_by'> {
  const mode: ExplorerMode = input.child.mode ?? 'explorer';
  const dest = input.destination;
  const name = input.child.name;
  const dietaryNote = input.child.dietary?.length
    ? `${name}: ${input.child.dietary.join(', ')} - confirm with the kitchen.`
    : undefined;

  const day: Day = {
    id: 'd_demo',
    date: input.date,
    label: `A day in ${dest}`,
    summary: `A taste of ${dest} built just for ${name}.`,
    did_you_know: `Every place has a secret - in ${dest}, the best ones are found by looking up.`,
    star_challenge: {
      title: `${name}'s ${dest} star hunt`,
      prompt: 'Find one thing today that surprises you and tell a grown-up about it.',
      stars: 3,
    },
    moments: [
      {
        id: 'm_1',
        slot: 'morning',
        title: `${dest} explorer walk`,
        time_hint: '09:30',
        activities: [
          {
            id: 'a_1',
            kind: 'kid',
            title: 'Spot five hidden things',
            body: `A gentle morning wander to wake up in ${dest}.`,
            facts: [
              `${dest} has stories on every corner - keep your eyes peeled!`,
              'Explorers notice the small things other people walk straight past.',
            ],
            challenge: {
              type: 'spot',
              prompt: 'Spot five hidden things on your morning walk.',
              stars: 2,
            },
            variants: {
              [mode]: {
                fact: `${dest} has stories on every corner - keep your eyes peeled!`,
                quiz: {
                  q: `What is the best way to explore a new city like ${dest}?`,
                  a: 'On foot, slowly, looking up and around.',
                },
              },
            },
          },
        ],
      },
      {
        id: 'm_2',
        slot: 'midday',
        title: 'Family lunch',
        time_hint: '12:30',
        activities: [
          {
            id: 'a_2',
            kind: 'shared',
            title: 'Try one new local dish',
            body: 'Pick something none of you have tasted before.',
            ...(dietaryNote ? { safety: { note: dietaryNote } } : {}),
          },
        ],
      },
      {
        id: 'm_3',
        slot: 'afternoon',
        title: 'Big adventure',
        time_hint: '15:00',
        activities: [
          {
            id: 'a_3',
            kind: 'kid',
            title: `${name}'s treasure hunt`,
            body: 'A playful hunt with little clues along the way.',
            variants: {
              [mode]: {
                fact: 'Treasure hunts are how explorers train their eyes.',
                quiz: { q: 'What makes a great explorer?', a: 'Curiosity and kindness.' },
              },
            },
          },
        ],
      },
      {
        id: 'm_4',
        slot: 'evening',
        title: 'Sunset wind-down',
        time_hint: '18:30',
        activities: [
          {
            id: 'a_4',
            kind: 'adult',
            title: 'Grown-ups breather',
            body: 'A calm spot to watch the day end while the kids draw the adventure.',
          },
        ],
      },
    ],
  };

  return { day, grownups_teaser: grownupsTeaser(input) };
}

// ===== Planning chat (use-our-AI, streaming) ================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanChatInput {
  destination: string;
  /** The current trip content, given to the model as planning context. */
  content: TripContent;
  /**
   * The family's intent, rendered as a short prose brief (see trip-intent.ts).
   * Same brief the BYO-AI MCP exposes, so first-party chat plans to the same
   * understanding. Empty/undefined when no intent has been captured yet.
   */
  brief?: string;
  messages: ChatMessage[];
}

/** The model that answers use-our-AI planning chat. */
export function chatModel(): string {
  return DEFAULT_MODEL;
}

export function chatGeneratedBy(): 'ai' | 'fallback' {
  return optionalEnv('ANTHROPIC_API_KEY') ? 'ai' : 'fallback';
}

const CHAT_SYSTEM =
  'You are the Yaycay family-holiday planning companion. You help a parent shape ' +
  'their trip: ideas for days and moments, kid-friendly tweaks, pacing, dietary and ' +
  'safety care, and gentle logistics. You can see the current itinerary as JSON for ' +
  'context. You do not edit it directly - you suggest, and the parent applies changes ' +
  'in the app. Keep replies warm, concrete, and concise. No em-dashes.';

function chatContext(input: PlanChatInput): string {
  const days = (input.content?.days ?? []).map((d) => ({
    id: d.id,
    date: d.date,
    label: d.label,
    moments: (d.moments ?? []).map((m) => ({ id: m.id, slot: m.slot, title: m.title })),
  }));
  const brief = input.brief?.trim() ? `${input.brief.trim()}\n\n` : '';
  return `${brief}Trip destination: ${input.destination}\nCurrent itinerary (for context):\n${
    JSON.stringify({ days }, null, 2)
  }`;
}

/**
 * Stream a planning-chat reply as a sequence of text deltas. Yields plain text
 * chunks; the edge function frames them as SSE. Falls back to a single canned
 * reply when no API key is configured, so the surface works offline.
 */
export async function* planChatDeltas(input: PlanChatInput): AsyncGenerator<string> {
  const apiKey = optionalEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    logAiSkipped('chat', 'no ANTHROPIC_API_KEY');
    yield fallbackChatReply(input);
    return;
  }

  logAiStart('chat', DEFAULT_MODEL);
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      stream: true,
      system: `${CHAT_SYSTEM}\n\n${chatContext(input)}`,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = res.body ? await res.text() : '(no body)';
    throw new Error(`Anthropic chat request failed: ${res.status} ${detail}`);
  }

  yield* parseAnthropicTextStream(res.body);
  logAiResult('chat', 'ai');
}

// Parse Anthropic's SSE stream, yielding only the text deltas.
async function* parseAnthropicTextStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json?.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
              yield json.delta.text as string;
            }
          } catch {
            // Skip non-JSON keepalive lines.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function fallbackChatReply(input: PlanChatInput): string {
  const last = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const dayCount = input.content?.days?.length ?? 0;
  const topic = last.trim().length > 0 ? ` about "${last.trim().slice(0, 80)}"` : '';
  return (
    `Happy to help plan ${input.destination}${topic}. ` +
    `You have ${dayCount} day${dayCount === 1 ? '' : 's'} mapped so far. ` +
    `A nice rhythm is one anchor activity per day with calm time around it, ` +
    `kept flexible for little legs. Tell me a day to focus on and I will suggest moments for it.`
  );
}

// ===== Ingestion (receipt / booking / note -> patch) ========================

export interface IngestImage {
  /** e.g. image/jpeg, image/png. */
  media_type: string;
  /** base64-encoded image bytes (no data: prefix). */
  data: string;
}

export interface IngestInput {
  destination: string;
  /** Free text: a note, a pasted confirmation, OCR output. */
  text?: string;
  /** A photo of a receipt/booking/ticket for the vision model. */
  image?: IngestImage;
  /** Optional targeting hint from the client. */
  hint?: { day_id?: string; moment_id?: string };
  /** Current content, so the model targets the right day/moment. */
  content: TripContent;
}

export interface IngestResult {
  patch: TripContentPatch;
  generated_by: 'ai' | 'fallback';
  model: string;
}

const INGEST_SYSTEM =
  'You turn a family-holiday receipt, booking, ticket, or note into a TripContentPatch ' +
  'for the Yaycay itinerary. Call the apply_patch tool with {"ops": [...], "note": "..."}. ' +
  'Choose the smallest set of ops that records the item against the right day/moment. ' +
  'Allowed ops: add_day{day}, set_day_summary{day_id,summary}, add_moment{day_id,moment}, ' +
  'add_activity{day_id,moment_id,activity}, update_activity{activity_id,set}, ' +
  'move_activity{activity_id,to_moment_id}, set_booking{activity_id,booking}. ' +
  'A booking is {name, time?, ref?, notes?}. An activity is {kind:"kid"|"shared"|"adult", ' +
  'title, body?, booking?}. Prefer attaching a booking to a relevant existing activity; ' +
  'otherwise add a new activity to a suitable moment. Use the provided ids exactly. No em-dashes.';

// Tool schema for ingestion. `ops` items are a union (one key per op kind), so
// the schema stays permissive - the API still guarantees valid JSON, and the
// apply path validates op shapes downstream.
const PATCH_TOOL = {
  name: 'apply_patch',
  description: 'Record the item as a TripContentPatch against the itinerary.',
  input_schema: {
    type: 'object',
    required: ['ops'],
    properties: {
      ops: {
        type: 'array',
        description: 'The smallest set of edit ops that records the item.',
        items: { type: 'object' },
      },
      note: { type: 'string', description: 'Short human-readable summary of the change.' },
    },
  },
};

function ingestContext(input: IngestInput): string {
  const days = (input.content?.days ?? []).map((d) => ({
    id: d.id,
    date: d.date,
    label: d.label,
    moments: (d.moments ?? []).map((m) => ({
      id: m.id,
      slot: m.slot,
      title: m.title,
      activities: (m.activities ?? []).map((a) => ({ id: a.id, title: a.title })),
    })),
  }));
  return JSON.stringify({ destination: input.destination, hint: input.hint, days }, null, 2);
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const apiKey = optionalEnv('ANTHROPIC_API_KEY');
  if (!apiKey || (!input.text && !input.image)) {
    logAiSkipped('ingest', !apiKey ? 'no ANTHROPIC_API_KEY' : 'no text or image');
    return { patch: fallbackIngestPatch(input), generated_by: 'fallback', model: 'fallback' };
  }

  logAiStart('ingest', DEFAULT_MODEL);
  try {
    const content: unknown[] = [
      {
        type: 'text',
        text: `Current itinerary and targeting hint:\n${ingestContext(input)}\n\n` +
          (input.text ? `Item text:\n${input.text}` : 'See the attached image.'),
      },
    ];
    if (input.image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: input.image.media_type, data: input.image.data },
      });
    }

    const data = await callAnthropicTool(apiKey, {
      system: INGEST_SYSTEM,
      maxTokens: 2048,
      tool: PATCH_TOOL,
      content,
      surface: 'ingest',
    });
    const parsed = data as TripContentPatch;
    if (!parsed || !Array.isArray(parsed.ops) || parsed.ops.length === 0) {
      throw new Error('Model returned no ops');
    }
    logAiResult('ingest', 'ai');
    return { patch: parsed, generated_by: 'ai', model: DEFAULT_MODEL };
  } catch (err) {
    // Never lose the parent's item on a model hiccup: record it deterministically.
    logAiError('ingest', err);
    return { patch: fallbackIngestPatch(input), generated_by: 'fallback', model: 'fallback' };
  }
}

// Deterministic ingestion: attach the item as a booking note to the hinted (or
// first) day, creating a day/moment if the itinerary is still empty.
function fallbackIngestPatch(input: IngestInput): TripContentPatch {
  const summary = (input.text ?? 'Saved item from a photo').trim().slice(0, 200);
  const activity: Activity = {
    id: '',
    kind: 'shared',
    title: 'Saved booking',
    body: summary,
    booking: { name: 'Captured item', notes: summary },
  };

  const days = input.content?.days ?? [];
  const targetDay = input.hint?.day_id ? days.find((d) => d.id === input.hint?.day_id) : days[0];

  if (targetDay) {
    const targetMoment = input.hint?.moment_id
      ? targetDay.moments.find((m) => m.id === input.hint?.moment_id)
      : targetDay.moments[0];
    if (targetMoment) {
      return {
        ops: [{ op: 'add_activity', day_id: targetDay.id, moment_id: targetMoment.id, activity }],
        note: 'Saved your item to the itinerary.',
      };
    }
    const moment: Moment = { id: '', slot: 'anytime', title: 'Bookings', activities: [activity] };
    return {
      ops: [{ op: 'add_moment', day_id: targetDay.id, moment }],
      note: 'Saved your item to the itinerary.',
    };
  }

  const day: Day = {
    id: '',
    label: 'Bookings',
    moments: [{ id: '', slot: 'anytime', title: 'Bookings', activities: [activity] }],
  };
  return { ops: [{ op: 'add_day', day }], note: 'Saved your item to a new day.' };
}
