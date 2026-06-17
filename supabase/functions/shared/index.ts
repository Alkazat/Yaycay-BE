// Public shared-trip surface (verify_jwt=false; the token is the capability):
//   GET  /shared/:token            resolve a shared trip (read-only, no auth)
//   POST /shared/:token/duplicate  copy the shared trip into the caller's
//                                  account (auth required; verified here)
//
// GET is the only place a non-owner reads a trip: itinerary + the owner's
// display name, nothing else. Reads go through the service role. The duplicate
// sub-route requires a Supabase JWT (verified via userContext) and writes the
// copy as the caller, so RLS still owns it. 404 for unknown/revoked/expired.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { UnauthorizedError, userContext } from '../_shared/user-client.ts';

const EMPTY_CONTENT = { trip: {}, days: [] };
const COPY_COLUMNS =
  'id, destination, start_date, end_date, timezone, currency, tier, status, retention_expires_at, created_at';

function pathSegments(pathname: string): string[] {
  const marker = '/shared';
  const i = pathname.indexOf(marker);
  const rest = i === -1 ? pathname : pathname.slice(i + marker.length);
  return rest.split('/').filter((s) => s.length > 0);
}

interface ResolvedShare {
  tripId: string;
  ownerId: string;
}

// Resolve an active (non-revoked, non-expired) share token to its trip.
async function resolveShare(token: string): Promise<ResolvedShare | null> {
  const { data: share, error: shareErr } = await serviceClient()
    .from('trip_shares')
    .select('trip_id, user_id, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle();
  if (shareErr) throw new Error(shareErr.message);
  const nowIso = new Date().toISOString();
  if (!share || share.revoked_at || (share.expires_at && (share.expires_at as string) < nowIso)) {
    return null;
  }
  return { tripId: share.trip_id as string, ownerId: share.user_id as string };
}

function dayCount(content: unknown): number {
  const days = (content as { days?: unknown[] } | null)?.days;
  return Array.isArray(days) ? days.length : 0;
}

// GET /shared/:token -> { shared_by, content } (public, read-only).
async function getShared(token: string): Promise<Response> {
  const share = await resolveShare(token);
  if (!share) return error('not_found', 'Unknown or expired share link.', 404);

  const db = serviceClient();
  const { data: tc } = await db
    .from('trip_content')
    .select('content')
    .eq('trip_id', share.tripId)
    .maybeSingle();
  const { data: acct } = await db
    .schema('identity')
    .from('accounts')
    .select('name')
    .eq('user_id', share.ownerId)
    .maybeSingle();
  const sharedBy = ((acct?.name as string | null) ?? '').trim() || 'A Yaycay family';

  return json({ shared_by: sharedBy, content: tc?.content ?? EMPTY_CONTENT });
}

// POST /shared/:token/duplicate -> a fresh free/draft trip the CALLER owns,
// copied from the shared trip. Auth required (the function is verify_jwt=false).
async function duplicateShared(req: Request, token: string): Promise<Response> {
  const share = await resolveShare(token);
  if (!share) return error('not_found', 'Unknown or expired share link.', 404);

  let ctx;
  try {
    ctx = await userContext(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    throw err;
  }

  // Read the source via the service role (the caller does not own it).
  const db = serviceClient();
  const { data: src } = await db
    .from('trips')
    .select('destination, start_date, end_date, timezone, currency')
    .eq('id', share.tripId)
    .maybeSingle();
  if (!src) return error('not_found', 'Shared trip is no longer available.', 404);
  const { data: srcContent } = await db
    .from('trip_content')
    .select('content')
    .eq('trip_id', share.tripId)
    .maybeSingle();
  const content = srcContent?.content ? JSON.parse(JSON.stringify(srcContent.content)) : null;

  // Write the copy AS THE CALLER so RLS owns it; tier/status default free/draft.
  const { data: copy, error: e2 } = await ctx.client
    .from('trips')
    .insert({
      user_id: ctx.userId,
      destination: src.destination,
      start_date: src.start_date,
      end_date: src.end_date,
      timezone: src.timezone,
      currency: src.currency,
    })
    .select(COPY_COLUMNS)
    .single();
  if (e2) throw new Error(e2.message);
  const { error: e3 } = await ctx.client
    .from('trip_content')
    .insert({ trip_id: copy.id, user_id: ctx.userId, content });
  if (e3) throw new Error(e3.message);

  return json({ ...copy, day_count: dayCount(content), data_kept: true }, 201);
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const seg = pathSegments(new URL(req.url).pathname);
  const token = seg[0] ?? '';
  if (!token) return error('not_found', 'Unknown share link.', 404);

  try {
    if (seg.length === 1 && req.method === 'GET') return await getShared(token);
    if (seg.length === 2 && seg[1] === 'duplicate' && req.method === 'POST') {
      return await duplicateShared(req, token);
    }
    return error('not_found', 'No such route.', 404);
  } catch (err) {
    console.error('shared handler error', err);
    return error('internal_error', 'Could not load the shared trip.', 500);
  }
});
