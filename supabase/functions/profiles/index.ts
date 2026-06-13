// /profiles - the caller's child profiles (CRUD).
//
// User-scoped: the gateway verifies the JWT and we run as the caller, so RLS
// (child_profiles_owner_all) scopes every row to their account. Profiles gate
// the per-child experience - explorer modes, journal tagging, stars/progress -
// so this is the first thing a signed-in family sets up.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';

const PROFILE_COLUMNS =
  'id, name, avatar, age, mode, interests, dietary, medical, created_at, updated_at';
const EXPLORER_MODES = ['little', 'standard', 'explorer', 'explorer_plus'];

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
