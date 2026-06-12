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
import type { Activity, Day, ExplorerMode, Moment, TripContent } from './content-types.ts';
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

export async function generateDemoDay(input: DemoDayInput): Promise<DemoDayResult> {
  const apiKey = optionalEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { ...buildFallbackDay(input), generated_by: 'fallback' };
  }

  try {
    const day = await generateWithClaude(input, apiKey);
    return {
      day,
      grownups_teaser: grownupsTeaser(input),
      generated_by: 'ai',
    };
  } catch (err) {
    // Never fail the demo on a model hiccup; degrade to the deterministic day.
    // Log the reason so a misconfigured key/model surfaces in the function logs
    // instead of silently serving the fallback.
    console.error('generateDemoDay: model call failed, using fallback:', err);
    return { ...buildFallbackDay(input), generated_by: 'fallback' };
  }
}

async function generateWithClaude(input: DemoDayInput, apiKey: string): Promise<Day> {
  const system =
    'You build a single delightful holiday day for a family travel app called Yaycay. ' +
    'Return ONLY JSON matching the provided shape. The day has 3-4 moments, each with ' +
    '1-2 activities. Use kind "kid" for child activities and "adult" for grown-up ones. ' +
    'For the child include a variants block keyed by their explorer mode with a fun fact ' +
    'and a single quiz. Surface any dietary flags as an activity safety note. ' +
    'Keep copy warm and sunny. No em-dashes.';

  const userPayload = {
    destination: input.destination,
    date: input.date,
    child: input.child,
    shape: {
      id: 'string',
      date: 'YYYY-MM-DD',
      label: 'string',
      summary: 'string',
      moments: [
        {
          id: 'string',
          slot: 'morning|midday|afternoon|evening|night|anytime',
          title: 'string',
          time_hint: 'HH:MM',
          activities: [
            {
              id: 'string',
              kind: 'kid|shared|adult',
              title: 'string',
              body: 'string',
              variants: { '<mode>': { fact: 'string', quiz: { q: 'string', a: 'string' } } },
              safety: { note: 'string' },
            },
          ],
        },
      ],
    },
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 2000,
      system,
      messages: [
        {
          role: 'user',
          content: `Build one day as JSON. Inputs:\n${JSON.stringify(userPayload, null, 2)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text: string =
    Array.isArray(data?.content) && data.content[0]?.type === 'text' ? data.content[0].text : '';
  const parsed = extractJson(text);
  return normaliseDay(parsed, input);
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Coerce model output into a well-formed Day, filling required ids/fields.
function normaliseDay(raw: unknown, input: DemoDayInput): Day {
  const r = (raw ?? {}) as Record<string, unknown>;
  const moments = Array.isArray(r.moments) ? r.moments : [];
  const day: Day = {
    id: typeof r.id === 'string' ? r.id : 'd_demo',
    date: typeof r.date === 'string' ? r.date : input.date,
    label: typeof r.label === 'string' ? r.label : `A day in ${input.destination}`,
    summary: typeof r.summary === 'string' ? r.summary : undefined,
    moments: moments.map((m, mi) => {
      const mm = (m ?? {}) as Record<string, unknown>;
      const acts = Array.isArray(mm.activities) ? mm.activities : [];
      return {
        id: typeof mm.id === 'string' ? mm.id : `m_${mi + 1}`,
        slot: isSlot(mm.slot) ? mm.slot : 'anytime',
        title: typeof mm.title === 'string' ? mm.title : `Moment ${mi + 1}`,
        time_hint: typeof mm.time_hint === 'string' ? mm.time_hint : undefined,
        activities: acts.map((a, ai) => {
          const aa = (a ?? {}) as Record<string, unknown>;
          return {
            id: typeof aa.id === 'string' ? aa.id : `a_${mi + 1}_${ai + 1}`,
            kind:
              aa.kind === 'kid' || aa.kind === 'shared' || aa.kind === 'adult' ? aa.kind : 'shared',
            title: typeof aa.title === 'string' ? aa.title : 'Activity',
            body: typeof aa.body === 'string' ? aa.body : undefined,
            variants: (aa.variants as Activity_variants) ?? undefined,
            safety: (aa.safety as { note?: string }) ?? undefined,
          };
        }),
      };
    }),
  };
  return day.moments.length > 0 ? day : buildFallbackDay(input).day;
}

type Activity_variants = NonNullable<Day['moments'][number]['activities'][number]['variants']>;

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
  return `Trip destination: ${input.destination}\nCurrent itinerary (for context):\n${JSON.stringify(
    { days },
    null,
    2,
  )}`;
}

/**
 * Stream a planning-chat reply as a sequence of text deltas. Yields plain text
 * chunks; the edge function frames them as SSE. Falls back to a single canned
 * reply when no API key is configured, so the surface works offline.
 */
export async function* planChatDeltas(input: PlanChatInput): AsyncGenerator<string> {
  const apiKey = optionalEnv('ANTHROPIC_API_KEY');
  if (!apiKey) {
    yield fallbackChatReply(input);
    return;
  }

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
  'for the Yaycay itinerary. Return ONLY a JSON object {"ops": [...], "note": "..."}. ' +
  'Choose the smallest set of ops that records the item against the right day/moment. ' +
  'Allowed ops: add_day{day}, set_day_summary{day_id,summary}, add_moment{day_id,moment}, ' +
  'add_activity{day_id,moment_id,activity}, update_activity{activity_id,set}, ' +
  'move_activity{activity_id,to_moment_id}, set_booking{activity_id,booking}. ' +
  'A booking is {name, time?, ref?, notes?}. An activity is {kind:"kid"|"shared"|"adult", ' +
  'title, body?, booking?}. Prefer attaching a booking to a relevant existing activity; ' +
  'otherwise add a new activity to a suitable moment. Use the provided ids exactly. No em-dashes.';

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
    return { patch: fallbackIngestPatch(input), generated_by: 'fallback', model: 'fallback' };
  }

  try {
    const content: unknown[] = [
      {
        type: 'text',
        text:
          `Current itinerary and targeting hint:\n${ingestContext(input)}\n\n` +
          (input.text ? `Item text:\n${input.text}` : 'See the attached image.'),
      },
    ];
    if (input.image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: input.image.media_type, data: input.image.data },
      });
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1500,
        system: INGEST_SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok)
      throw new Error(`Anthropic ingest request failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    const text: string =
      Array.isArray(data?.content) && data.content[0]?.type === 'text' ? data.content[0].text : '';
    const parsed = extractJson(text) as TripContentPatch;
    if (!parsed || !Array.isArray(parsed.ops) || parsed.ops.length === 0) {
      throw new Error('Model returned no ops');
    }
    return { patch: parsed, generated_by: 'ai', model: DEFAULT_MODEL };
  } catch (err) {
    // Never lose the parent's item on a model hiccup: record it deterministically.
    // Log the reason so a misconfigured key/model is visible in the logs.
    console.error('ingestToPatch: model call failed, using fallback:', err);
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
