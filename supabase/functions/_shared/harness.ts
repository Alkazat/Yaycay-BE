// Model-agnostic AI harness (Phase 0 slice: the free-demo day generator).
//
// The full harness wraps Claude / Gemini / OpenAI and is driven by the active
// `prompts` row chosen in Admin. For Phase 0 we expose a single demo generator
// that defaults to Claude Sonnet (the use-our-AI tier model) and falls back to
// a deterministic builder when no API key is configured, so the demo and smoke
// test always produce a valid day.

import { optionalEnv } from './env.ts';
import type { Day, ExplorerMode } from './content-types.ts';

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
  } catch (_err) {
    // Never fail the demo on a model hiccup; degrade to the deterministic day.
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
    throw new Error(`Anthropic request failed: ${res.status}`);
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
