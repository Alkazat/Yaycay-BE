// BYO-AI connector management (user-scoped).
//   POST /connectors/byo-ai   mint a scoped MCP token for a trip (tier=byo)
//   GET  /connectors          list the caller's connectors (status)
//   POST /connectors/:id/revoke   revoke a connector
//
// The token is scoped to one trip; the parent adds it to their own ChatGPT /
// Claude / Gemini as an MCP connector. Tokens are not stored; revocation is via
// the connector row's revoked_at, which the MCP endpoint checks on every call.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { mintToken } from '../_shared/mcp-token.ts';

const DEFAULT_SCOPES = [
  'get_trip_brief',
  'set_trip_brief',
  'get_trip',
  'list_days',
  'add_activity',
  'update_activity',
  'move_activity',
  'add_moment',
  'set_packing_list',
  'import_reservation',
  'optimise_day',
];

function segments(url: URL): string[] {
  const i = url.pathname.indexOf('/connectors');
  const sub = i === -1 ? url.pathname : url.pathname.slice(i + '/connectors'.length);
  return sub.split('/').filter((s) => s.length > 0);
}

function statusOf(row: { revoked_at: string | null }): 'active' | 'revoked' {
  return row.revoked_at ? 'revoked' : 'active';
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const url = new URL(req.url);
    const seg = segments(url);
    const { client, userId } = await userContext(req);

    // GET /connectors
    // Defence-in-depth: explicit owner filter in addition to RLS, since there is
    // no explorer-read policy on connectors and a belt-and-braces eq() costs
    // nothing. An explorer should never reach this endpoint, but if they do the
    // explicit filter ensures they see nothing.
    if (seg.length === 0 && req.method === 'GET') {
      const { data, error: dbErr } = await client
        .from('connectors')
        .select('id, trip_id, label, scopes, last_used_at, revoked_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (dbErr) throw new Error(dbErr.message);
      const connectors = (data ?? []).map((c) => ({ ...c, status: statusOf(c) }));
      return json({ connectors });
    }

    // POST /connectors/byo-ai
    if (seg.length === 1 && seg[0] === 'byo-ai' && req.method === 'POST') {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // body optional
      }
      const tripId = typeof body.trip_id === 'string' ? body.trip_id : '';
      if (!tripId) return error('validation_error', 'trip_id is required.', 422, ['trip_id']);

      const { data: trip, error: tErr } = await client
        .from('trips')
        .select('id, tier')
        .eq('id', tripId)
        .maybeSingle();
      if (tErr) throw new Error(tErr.message);
      if (!trip) return error('not_found', 'Trip not found or not visible to the caller.', 404);
      if (trip.tier !== 'byo') {
        return error('entitlement_required', 'BYO-AI connectors require the byo tier.', 403, [
          'Requires tier: byo.',
        ]);
      }

      const label = typeof body.label === 'string' ? body.label : null;
      const { data: connector, error: insErr } = await client
        .from('connectors')
        .insert({ user_id: userId, trip_id: tripId, label, scopes: DEFAULT_SCOPES })
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);

      const token = await mintToken({
        cid: connector.id as string,
        uid: userId,
        tid: tripId,
        scope: DEFAULT_SCOPES,
        iat: Math.floor(Date.now() / 1000),
      });
      const mcpUrl = `${url.origin}/functions/v1/mcp`;
      return json({ connector_id: connector.id, token, mcp_url: mcpUrl }, 201);
    }

    // POST /connectors/:id/revoke
    if (seg.length === 2 && seg[1] === 'revoke' && req.method === 'POST') {
      const { data, error: dbErr } = await client
        .from('connectors')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', seg[0])
        .select('id, revoked_at')
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) return error('not_found', 'Connector not found.', 404);
      return json({ id: data.id, status: 'revoked' });
    }

    return error('not_found', 'No such route.', 404);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('connectors handler error', err);
    return error('internal_error', 'Unexpected error.', 500);
  }
});
