// /profiles - the caller's child profiles (CRUD).
//
// User-scoped: the gateway verifies the JWT and we run as the caller, so RLS
// (child_profiles_owner_all) scopes every row to their account. Profiles gate
// the per-child experience - explorer modes, journal tagging, stars/progress -
// so this is the first thing a signed-in family sets up.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';

const PROFILE_COLUMNS =
  'id, name, avatar, age, mode, type, pin_hash, interests, dietary, medical, created_at, updated_at';
const EXPLORER_MODES = ['little', 'standard', 'explorer', 'explorer_plus'];
const PROFILE_TYPES = ['child', 'guardian'];

const PIN_RE = /^\d{4}$/;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

class ValidationError extends Error {
  constructor(readonly details: string[]) {
    super('validation_error');
  }
}

function segments(url: URL): string[] {
  const marker = '/profiles';
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

function toProfile(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    avatar: (r.avatar as string | null) ?? null,
    age: (r.age as number | null) ?? null,
    mode: (r.mode as string | null) ?? null,
    type: (r.type as string) ?? 'child',
    // Never return the PIN hash; expose only whether a PIN is configured.
    pin_set: r.pin_hash != null,
    interests: Array.isArray(r.interests) ? r.interests : [],
    dietary: Array.isArray(r.dietary) ? r.dietary : [],
    medical: Array.isArray(r.medical) ? r.medical : [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

// Build the writable column set from the body. `requireName` is true on create.
function parseProfile(
  body: Record<string, unknown>,
  requireName: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const errs: string[] = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      errs.push('name must be a non-empty string');
    } else {
      out.name = body.name.trim();
    }
  } else if (requireName) {
    errs.push('name is required');
  }

  if (body.avatar !== undefined) {
    out.avatar = typeof body.avatar === 'string' ? body.avatar : null;
  }

  if (body.age !== undefined) {
    if (body.age === null) {
      out.age = null;
    } else {
      const n = Number(body.age);
      if (!Number.isInteger(n) || n < 0 || n > 18) errs.push('age must be an integer 0-18');
      else out.age = n;
    }
  }

  if (body.mode !== undefined) {
    if (body.mode === null) out.mode = null;
    else if (!EXPLORER_MODES.includes(String(body.mode))) {
      errs.push('mode must be little|standard|explorer|explorer_plus');
    } else {
      out.mode = body.mode;
    }
  }

  if (body.type !== undefined) {
    if (!PROFILE_TYPES.includes(String(body.type))) errs.push('type must be child or guardian');
    else out.type = body.type;
  }

  for (const f of ['interests', 'dietary', 'medical'] as const) {
    if (body[f] !== undefined) {
      const arr = stringArray(body[f]);
      if (!arr) errs.push(`${f} must be an array of strings`);
      else out[f] = arr;
    }
  }

  if (errs.length > 0) throw new ValidationError(errs);
  return out;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const url = new URL(req.url);
    const seg = segments(url);
    const { client, userId } = await userContext(req);

    // /profiles
    if (seg.length === 0) {
      if (req.method === 'GET') {
        const { data, error: dbErr } = await client
          .from('child_profiles')
          .select(PROFILE_COLUMNS)
          .order('created_at', { ascending: true });
        if (dbErr) throw new Error(dbErr.message);
        return json({ profiles: (data ?? []).map((r) => toProfile(r as Record<string, unknown>)) });
      }
      if (req.method === 'POST') {
        const fields = parseProfile(await readJson(req), true);
        const { data, error: dbErr } = await client
          .from('child_profiles')
          .insert({ user_id: userId, ...fields })
          .select(PROFILE_COLUMNS)
          .single();
        if (dbErr) throw new Error(dbErr.message);
        return json(toProfile(data as Record<string, unknown>), 201);
      }
      return error('method_not_allowed', 'Use GET or POST.', 405);
    }

    // /profiles/:id
    if (seg.length === 1) {
      const id = seg[0];
      if (req.method === 'PATCH') {
        const fields = parseProfile(await readJson(req), false);
        if (Object.keys(fields).length === 0) {
          return error('validation_error', 'No updatable fields provided.', 422);
        }
        const { data, error: dbErr } = await client
          .from('child_profiles')
          .update(fields)
          .eq('id', id)
          .select(PROFILE_COLUMNS)
          .maybeSingle();
        if (dbErr) throw new Error(dbErr.message);
        if (!data) return error('not_found', 'Profile not found.', 404);
        return json(toProfile(data as Record<string, unknown>));
      }
      if (req.method === 'DELETE') {
        const { data, error: dbErr } = await client
          .from('child_profiles')
          .delete()
          .eq('id', id)
          .select('id')
          .maybeSingle();
        if (dbErr) throw new Error(dbErr.message);
        if (!data) return error('not_found', 'Profile not found.', 404);
        return json({ deleted: true });
      }
      return error('method_not_allowed', 'Use PATCH or DELETE.', 405);
    }

    // /profiles/:id/pin - set/change a guardian PIN (write-only).
    if (seg.length === 2 && seg[1] === 'pin' && req.method === 'POST') {
      return await setPin(client, seg[0], req);
    }

    // /profiles/:id/pin/verify - verify the PIN to unlock the Grown-ups view.
    if (seg.length === 3 && seg[1] === 'pin' && seg[2] === 'verify' && req.method === 'POST') {
      return await verifyPin(client, seg[0], req);
    }

    return error('not_found', 'No such route.', 404);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    if (err instanceof ValidationError) {
      return error('validation_error', 'Request failed validation.', 422, err.details);
    }
    console.error('profiles handler error', err);
    return error('internal_error', 'Unexpected error.', 500);
  }
});

// ----- Guardian PIN (Grown-ups gate) ----------------------------------------
// Set/verify a 4-digit PIN on a guardian profile. The PIN is hashed (PBKDF2)
// server-side and never returned; verify is rate-limited (lock after N fails).
// This is a child-safety UX lock, not a hardened boundary (low-entropy by design).

type ProfileClient = Awaited<ReturnType<typeof userContext>>['client'];

async function setPin(client: ProfileClient, id: string, req: Request): Promise<Response> {
  const body = await readJson(req);
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!PIN_RE.test(pin)) throw new ValidationError(['pin must be 4 digits']);

  const { data: existing, error: selErr } = await client
    .from('child_profiles')
    .select('id, type')
    .eq('id', id)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!existing) return error('not_found', 'Profile not found.', 404);
  if (existing.type !== 'guardian') {
    return error('validation_error', 'A PIN can only be set on a guardian profile.', 422);
  }

  const pinHash = await hashPin(pin);
  const { data, error: dbErr } = await client
    .from('child_profiles')
    .update({ pin_hash: pinHash, pin_attempts: 0, pin_locked_until: null })
    .eq('id', id)
    .select(PROFILE_COLUMNS)
    .single();
  if (dbErr) throw new Error(dbErr.message);
  return json(toProfile(data as Record<string, unknown>));
}

async function verifyPin(client: ProfileClient, id: string, req: Request): Promise<Response> {
  const body = await readJson(req);
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!PIN_RE.test(pin)) throw new ValidationError(['pin must be 4 digits']);

  const { data, error: selErr } = await client
    .from('child_profiles')
    .select('id, pin_hash, pin_attempts, pin_locked_until')
    .eq('id', id)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!data) return error('not_found', 'Profile not found.', 404);
  if (!data.pin_hash) return error('validation_error', 'No PIN is set for this profile.', 422);

  const lockedUntil = data.pin_locked_until ? new Date(data.pin_locked_until as string) : null;
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    return error('rate_limited', 'Too many attempts. Try again later.', 429);
  }

  if (await verifyPinHash(pin, data.pin_hash as string)) {
    await client
      .from('child_profiles')
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq('id', id);
    return json({ verified: true });
  }

  // Wrong PIN: count the attempt and lock after the cap.
  const attempts = ((data.pin_attempts as number) ?? 0) + 1;
  const update =
    attempts >= MAX_PIN_ATTEMPTS
      ? {
          pin_attempts: 0,
          pin_locked_until: new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString(),
        }
      : { pin_attempts: attempts };
  await client.from('child_profiles').update(update).eq('id', id);
  return json({ verified: false });
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// Stored as `pbkdf2$<iterations>$<saltHex>$<hashHex>`.
async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, 100_000);
  return `pbkdf2$100000$${toHex(salt)}$${toHex(hash)}`;
}

async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations)) return false;
  const actual = toHex(await pbkdf2(pin, fromHex(parts[2]), iterations));
  const expected = parts[3];
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
