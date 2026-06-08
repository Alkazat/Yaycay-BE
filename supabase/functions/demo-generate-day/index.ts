// POST /demo/generate-day - the free-demo hook.
// One AI-built day for one person, with one quiz and a grown-ups teaser.
// Public and rate-limited per IP. The single AI action is never advertised.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { generateDemoDay, type DemoDayInput } from '../_shared/harness.ts';

const RATE_LIMIT_PER_HOUR = Number(Deno.env.get('DEMO_RATE_LIMIT_PER_HOUR') ?? '20');

// Best-effort in-memory limiter. A warm instance smooths bursts; durable
// limiting (e.g. via the database or an edge KV) lands with the gateway work.
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_HOUR;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? (fwd.split(',')[0]?.trim() ?? 'unknown') : 'unknown';
}

function validate(
  body: unknown,
): { ok: true; input: DemoDayInput } | { ok: false; details: string[] } {
  const details: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.destination !== 'string' || b.destination.trim().length === 0) {
    details.push('destination is required');
  }
  const child = (b.child ?? {}) as Record<string, unknown>;
  if (typeof child.name !== 'string' || child.name.trim().length === 0) {
    details.push('child.name is required');
  }
  if (details.length > 0) return { ok: false, details };

  return {
    ok: true,
    input: {
      destination: (b.destination as string).trim(),
      date: typeof b.date === 'string' ? b.date : undefined,
      child: {
        name: (child.name as string).trim(),
        age: typeof child.age === 'number' ? child.age : undefined,
        mode:
          child.mode === 'little' || child.mode === 'explorer' || child.mode === 'explorer_plus'
            ? child.mode
            : undefined,
        interests: Array.isArray(child.interests)
          ? (child.interests as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
        dietary: Array.isArray(child.dietary)
          ? (child.dietary as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
      },
    },
  };
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return error('method_not_allowed', 'Use POST.', 405);
  }

  if (rateLimited(clientIp(req))) {
    return error('rate_limited', 'Too many demo requests. Try again later.', 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error('invalid_json', 'Request body must be JSON.', 422);
  }

  const checked = validate(body);
  if (!checked.ok) {
    return error('validation_error', 'Request failed validation.', 422, checked.details);
  }

  const result = await generateDemoDay(checked.input);
  return json(result, 200);
});
