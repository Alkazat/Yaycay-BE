// POST /media/sign-upload - mint a short-lived signed upload URL for trip media.
//
// User-scoped, paid feature. The bytes never touch the function: we record a
// media_assets row (service role), mint a signed upload URL for a path under the
// owner's folder, and return it. The client PUTs the file straight to Storage
// with the token. The returned `media_ref` is stored in journal entries /
// trip_content; reads resolve it to a signed download URL.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';

const BUCKET = 'trip-media';
const PAID = new Set(['byo', 'ours']);

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);

  try {
    const { client, userId } = await userContext(req);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return error('validation_error', 'Request body must be JSON.', 422);
    }

    const tripId = typeof body.trip_id === 'string' ? body.trip_id : '';
    if (!tripId) return error('validation_error', 'trip_id is required.', 422, ['trip_id']);
    const contentType =
      typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream';

    // The trip must be visible to the caller (RLS) and on a paid tier.
    const { data: trip, error: tErr } = await client
      .from('trips')
      .select('id, tier')
      .eq('id', tripId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!trip) return error('not_found', 'Trip not found or not visible to the caller.', 404);
    if (!PAID.has(trip.tier as string)) {
      return error('entitlement_required', 'Media uploads require a paid tier.', 403, [
        'Requires tier: byo or ours.',
      ]);
    }

    const svc = serviceClient();
    const id = crypto.randomUUID();
    const path = `${userId}/${id}`;

    const { error: insErr } = await svc
      .from('media_assets')
      .insert({ id, user_id: userId, trip_id: tripId, path, content_type: contentType });
    if (insErr) throw new Error(insErr.message);

    const { data: signed, error: sErr } = await svc.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (sErr || !signed) throw new Error(sErr?.message ?? 'Could not sign the upload.');

    return json({ media_ref: id, path, upload_url: signed.signedUrl, token: signed.token }, 200);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('media sign-upload error', err);
    return error('internal_error', 'Could not sign the upload.', 500);
  }
});
