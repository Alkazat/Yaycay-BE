// /profiles - the caller's child profiles (CRUD).
//
// User-scoped: the gateway verifies the JWT and we run as the caller, so RLS
// (child_profiles_owner_all) scopes every row to their account. Profiles gate
// the per-child experience - explorer modes, journal tagging, stars/progress -
// so this is the first thing a signed-in family sets up.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';

const PROFILE_COLUMNS =
  'id, name, avatar, age, mode, type, pin_hash, interests, dietary, medical, created_at, updated_at';
const EXPLORER_MODES = ['little', 'standard', 'explorer', 'explorer_plus'];
const PROFILE_TYPES = ['child', 'parent_carer'];

const PIN_RE = /^\d{4}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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
    if (!PROFILE_TYPES.includes(String(body.type))) errs.push('type must be child or parent_carer');
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
        // NOTE: no explicit .eq('user_id', userId) here by design. Two RLS
        // policies govern this table:
        //   1. child_profiles_owner_all: user_id = auth.uid() OR is_admin()
        //      → a parent sees their own family's profiles.
        //   2. child_profiles_explorer_self: id = app.explorer_profile_id()
        //      → a linked explorer sees ONLY their own single profile row.
        //
        // Adding .eq('user_id', userId) would break case 2: an explorer's
        // auth.uid() is their own user id, but child_profiles.user_id holds the
        // parent account's user id. RLS is the correct and sole filter here.
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

    // /profiles/:id/login - the profile's optional own magic-link login.
    if (seg.length === 2 && seg[1] === 'login') {
      if (req.method === 'GET') return await getLogin(client, seg[0]);
      if (req.method === 'POST') return await enableLogin(client, userId, seg[0], req);
      if (req.method === 'DELETE') return await disableLogin(client, seg[0]);
      return error('method_not_allowed', 'Use GET, POST or DELETE.', 405);
    }

    // /profiles/:id/pin - set/change a parent/carer PIN (write-only).
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

// ----- Parent/carer PIN (Grown-ups gate) ------------------------------------
// Set/verify a 4-digit PIN on a parent_carer profile. The PIN is hashed (PBKDF2)
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
  if (existing.type !== 'parent_carer') {
    return error('validation_error', 'A PIN can only be set on a parent/carer profile.', 422);
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

  // Already locked: report the lock window so the client can show a countdown.
  const lockedUntil = data.pin_locked_until ? new Date(data.pin_locked_until as string) : null;
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    return json({
      verified: false,
      attempts_remaining: 0,
      locked_until: lockedUntil.toISOString(),
    });
  }

  if (await verifyPinHash(pin, data.pin_hash as string)) {
    await client
      .from('child_profiles')
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq('id', id);
    return json({ verified: true, attempts_remaining: MAX_PIN_ATTEMPTS, locked_until: null });
  }

  // Wrong PIN: count the attempt and lock after the cap.
  const attempts = ((data.pin_attempts as number) ?? 0) + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    const lockIso = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString();
    await client
      .from('child_profiles')
      .update({ pin_attempts: 0, pin_locked_until: lockIso })
      .eq('id', id);
    return json({ verified: false, attempts_remaining: 0, locked_until: lockIso });
  }
  await client.from('child_profiles').update({ pin_attempts: attempts }).eq('id', id);
  return json({
    verified: false,
    attempts_remaining: MAX_PIN_ATTEMPTS - attempts,
    locked_until: null,
  });
}

// ----- Explorer logins (a profile's optional own magic-link account) --------
// A child_profile can be linked to its OWN auth.users so the explorer can sign
// in and explore the family's trips read-only. The parent account still owns the
// data; RLS (migration 0034) scopes a linked explorer to just their slice.
// Provisioning mints the auth.users via the service role; clients never write
// public.explorer_logins directly.

type LoginRow = {
  id?: string;
  auth_user_id?: string;
  email?: string;
  invited_at?: string;
  disabled_at?: string | null;
};

function loginStatus(row: LoginRow | null): Record<string, unknown> {
  if (!row) return { enabled: false, email: null, invited_at: null, disabled_at: null };
  return {
    enabled: !row.disabled_at,
    email: row.email ?? null,
    invited_at: row.invited_at ?? null,
    disabled_at: row.disabled_at ?? null,
  };
}

// Confirm the caller owns the profile (RLS on the user client); 404 otherwise.
async function assertOwnsProfile(
  client: ProfileClient,
  profileId: string,
): Promise<Response | null> {
  const { data, error: selErr } = await client
    .from('child_profiles')
    .select('id')
    .eq('id', profileId)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!data) return error('not_found', 'Profile not found.', 404);
  return null;
}

async function getLogin(client: ProfileClient, profileId: string): Promise<Response> {
  const missing = await assertOwnsProfile(client, profileId);
  if (missing) return missing;
  const { data, error: selErr } = await client
    .from('explorer_logins')
    .select('email, invited_at, disabled_at')
    .eq('child_profile_id', profileId)
    .is('disabled_at', null)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  return json(loginStatus((data as LoginRow | null) ?? null));
}

async function enableLogin(
  client: ProfileClient,
  userId: string,
  profileId: string,
  req: Request,
): Promise<Response> {
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) throw new ValidationError(['email must be a valid email address']);

  const missing = await assertOwnsProfile(client, profileId);
  if (missing) return missing;

  // Idempotent: an existing active login is returned unchanged (no new link).
  const { data: existing, error: exErr } = await client
    .from('explorer_logins')
    .select('email, invited_at, disabled_at')
    .eq('child_profile_id', profileId)
    .is('disabled_at', null)
    .maybeSingle();
  if (exErr) throw new Error(exErr.message);
  if (existing) return json({ ...loginStatus(existing as LoginRow), action_link: null }, 200);

  const svc = serviceClient();

  // Provision (or resolve) the explorer's auth user + a one-time sign-in link.
  // generateLink(magiclink) creates the user if needed and returns the action link.
  const link = await svc.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data?.user) {
    throw new Error(link.error?.message ?? 'Could not provision the explorer login.');
  }
  const authUserId = link.data.user.id;
  const actionLink = (link.data.properties?.action_link as string | undefined) ?? null;

  // Never attach an explorer login to an account that already owns data (e.g. a
  // parent). A freshly-created explorer user owns nothing, so this passes.
  const { count, error: cntErr } = await svc
    .from('child_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', authUserId);
  if (cntErr) throw new Error(cntErr.message);
  if ((count ?? 0) > 0) {
    return error('validation_error', 'That email already belongs to a Yaycay account.', 422);
  }

  const { data: row, error: insErr } = await svc
    .from('explorer_logins')
    .insert({
      child_profile_id: profileId,
      auth_user_id: authUserId,
      parent_user_id: userId,
      email,
    })
    .select('email, invited_at, disabled_at')
    .single();
  if (insErr) {
    if (String(insErr.message).includes('explorer_logins_auth_user_key')) {
      return error('validation_error', 'That email is already used by another explorer.', 422);
    }
    throw new Error(insErr.message);
  }
  return json({ ...loginStatus(row as LoginRow), action_link: actionLink }, 201);
}

async function disableLogin(client: ProfileClient, profileId: string): Promise<Response> {
  // The parent can read their own link (RLS); use it to find the active one.
  const { data: link, error: selErr } = await client
    .from('explorer_logins')
    .select('id, auth_user_id, email, invited_at')
    .eq('child_profile_id', profileId)
    .is('disabled_at', null)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!link) return error('not_found', 'No active login for this profile.', 404);
  const row = link as LoginRow;

  const svc = serviceClient();
  const disabledAt = new Date().toISOString();
  const { error: upErr } = await svc
    .from('explorer_logins')
    .update({ disabled_at: disabledAt })
    .eq('id', row.id as string);
  if (upErr) throw new Error(upErr.message);

  // Best-effort: ban the explorer's auth user so any live session or pending
  // magic link stops working immediately. RLS already revokes data access, so a
  // failure here is non-fatal.
  try {
    await svc.auth.admin.updateUserById(row.auth_user_id as string, { ban_duration: '876000h' });
  } catch (_e) {
    // Soft-disable above is the source of truth; the ban is defence in depth.
  }

  return json({
    enabled: false,
    email: row.email ?? null,
    invited_at: row.invited_at ?? null,
    disabled_at: disabledAt,
  });
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
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
