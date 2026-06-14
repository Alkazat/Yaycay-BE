// BYO-AI connector management (user-scoped) - the "Connected assistants" surface.
//   POST /connectors/byo-ai            mint a scoped MCP token for a trip (tier=byo)
//   GET  /connectors                   list the caller's connectors AND OAuth
//                                       grants, unified by a `kind` field
//   POST /connectors/:id/revoke        revoke a connector
//   POST /connectors/grants/:id/revoke revoke an OAuth grant
//
// A connector token is scoped to one trip; an OAuth grant is account-wide. The
// parent adds either to their own ChatGPT / Claude / Gemini. Connector tokens are
// not stored (revoked via connectors.revoked_at); OAuth grants live in
// oauth_grants (service-role only), so we read/write them with the service client
// filtered to the caller, and the MCP endpoint checks revoked_at on every call.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { UnauthorizedError, userContext } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { mintToken } from '../_shared/mcp-token.ts';

const DEFAULT_SCOPES = [
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

    // GET /connectors - unified "Connected assistants": per-trip connector tokens
    // plus account-scoped OAuth grants, each tagged with `kind`.
    if (seg.length === 0 && req.method === 'GET') {
      // Connector tokens (RLS scopes these to the caller).
      const { data: rows, error: dbErr } = await client
        .from('connectors')
        .select('id, trip_id, label, scopes, last_used_at, revoked_at, created_at')
        .order('created_at', { ascending: false });
      if (dbErr) throw new Error(dbErr.message);
      const connectorItems = (rows ?? []).map((c) => ({
        kind: 'connector' as const,
        id: c.id,
        trip_id: c.trip_id,
        label: c.label,
        scopes: c.scopes ?? [],
        last_used_at: c.last_used_at,
        created_at: c.created_at,
        status: statusOf(c),
      }));

      // OAuth grants live in a service-role-only table, so read them with the
      // service client filtered to this user, and return only a sanitized shape
      // (no token hashes, no captured Supabase tokens).
      const { data: grants, error: gErr } = await serviceClient()
        .from('oauth_grants')
        .select(
          'id, scope, last_used_at, revoked_at, created_at, client_id, oauth_clients(client_name)',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (gErr) throw new Error(gErr.message);
      const grantItems = (grants ?? []).map((g) => {
        const clientRel = g.oauth_clients as { client_name: string | null } | null;
        return {
          kind: 'oauth' as const,
          id: g.id,
          label: clientRel?.client_name ?? g.client_id,
          scopes: String(g.scope ?? '')
            .split(/\s+/)
            .filter(Boolean),
          last_used_at: g.last_used_at,
          created_at: g.created_at,
          status: statusOf(g),
        };
      });

      return json({ connectors: [...connectorItems, ...grantItems] });
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

    // POST /connectors/grants/:id/revoke - revoke an OAuth grant. The grant table
    // is service-role only, so we write with the service client but constrain to
    // the caller's own rows, and the MCP endpoint honours revoked_at immediately.
    if (seg.length === 3 && seg[0] === 'grants' && seg[2] === 'revoke' && req.method === 'POST') {
      const { data, error: dbErr } = await serviceClient()
        .from('oauth_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', seg[1])
        .eq('user_id', userId)
        .select('id')
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) return error('not_found', 'Grant not found.', 404);
      return json({ id: data.id, status: 'revoked' });
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
