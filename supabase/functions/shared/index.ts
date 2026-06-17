// GET /shared/:token - public, read-only resolve of a shared trip.
//
// The only place a non-owner reads a trip. A share token (minted by
// POST /trips/:id/share) maps to exactly one trip; we return the same
// TripContent the owner view renders, plus a friendly "shared by" name. No
// auth (verify_jwt=false), no profile/PII beyond the itinerary + display name.
// Reads go through the service role; the token is the capability. 404 for an
// unknown, revoked, or expired token.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { serviceClient } from '../_shared/service-client.ts';

const EMPTY_CONTENT = { trip: {}, days: [] };

function tokenFromPath(pathname: string): string {
  const marker = '/shared';
  const i = pathname.indexOf(marker);
  const rest = i === -1 ? pathname : pathname.slice(i + marker.length);
  return rest.split('/').filter((s) => s.length > 0)[0] ?? '';
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'GET') return error('method_not_allowed', 'Use GET.', 405);

  const token = tokenFromPath(new URL(req.url).pathname);
  if (!token) return error('not_found', 'Unknown share link.', 404);

  try {
    const db = serviceClient();
    const { data: share, error: shareErr } = await db
      .from('trip_shares')
      .select('trip_id, user_id, expires_at, revoked_at')
      .eq('token', token)
      .maybeSingle();
    if (shareErr) throw new Error(shareErr.message);

    const nowIso = new Date().toISOString();
    if (!share || share.revoked_at || (share.expires_at && (share.expires_at as string) < nowIso)) {
      return error('not_found', 'Unknown or expired share link.', 404);
    }

    const { data: tc } = await db
      .from('trip_content')
      .select('content')
      .eq('trip_id', share.trip_id as string)
      .maybeSingle();

    const { data: acct } = await db
      .schema('identity')
      .from('accounts')
      .select('name')
      .eq('user_id', share.user_id as string)
      .maybeSingle();
    const sharedBy = ((acct?.name as string | null) ?? '').trim() || 'A Yaycay family';

    return json({ shared_by: sharedBy, content: tc?.content ?? EMPTY_CONTENT });
  } catch (err) {
    console.error('shared resolve error', err);
    return error('internal_error', 'Could not load the shared trip.', 500);
  }
});
