// Customer trip API (contract v0.1):
//   GET  /trips                 list the caller's trips
//   POST /trips                 create a trip
//   GET  /trips/:id             get one trip
//   GET  /trips/:id/content     read the canonical trip_content
//   PATCH /trips/:id/content    replace trip_content (schema-validated)
//
// Runs as the authenticated caller; Row-Level Security enforces ownership.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { validateTripContent } from '../_shared/trip-content-validate.ts';

const TRIP_COLUMNS =
  'id, destination, start_date, end_date, timezone, currency, tier, status, retention_expires_at, created_at';

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
          .select(TRIP_COLUMNS)
          .order('created_at', { ascending: false });
        if (dbErr) throw new Error(dbErr.message);
        return json({ trips: data ?? [] });
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

    // /trips/:id
    if (seg.length === 1) {
      if (req.method !== 'GET') return error('method_not_allowed', 'Use GET.', 405);
      const { data, error: dbErr } = await client
        .from('trips')
        .select(TRIP_COLUMNS)
        .eq('id', tripId)
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) throw new NotFoundError();
      return json(data);
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
    console.error('trips handler error', err);
    return error('internal_error', 'Unexpected error.', 500);
  }
});
