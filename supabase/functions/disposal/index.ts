// POST /disposal - run the retention disposal sweep.
//
// Deletes every trip past its retention date (trip children cascade; the
// purchase record survives via on-delete-set-null). Public at the gateway
// (verify_jwt=false) and guarded by a shared `DISPOSAL_SECRET` so only the
// scheduler can trigger it. Without the secret the endpoint reports disabled,
// so a misconfigured environment never silently deletes data. The in-DB pg_cron
// job runs the same sweep; this endpoint is the portable fallback trigger.

import { error, json, handlePreflight } from '../_shared/http.ts';
import { optionalEnv } from '../_shared/env.ts';
import { serviceClient } from '../_shared/service-client.ts';

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);

  const secret = optionalEnv('DISPOSAL_SECRET');
  if (!secret) return error('disposal_disabled', 'Disposal endpoint is not configured.', 503);

  const provided = req.headers.get('x-disposal-secret') ?? '';
  if (provided.length !== secret.length || provided !== secret) {
    return error('unauthorized', 'Invalid disposal secret.', 401);
  }

  try {
    const db = serviceClient();
    const { data, error: delErr } = await db
      .from('trips')
      .delete()
      .not('retention_expires_at', 'is', null)
      .lt('retention_expires_at', new Date().toISOString())
      .select('id');
    if (delErr) throw new Error(delErr.message);
    return json({ disposed: data?.length ?? 0 }, 200);
  } catch (err) {
    console.error('disposal handler error', err);
    return error('internal_error', 'Could not run the disposal sweep.', 500);
  }
});
