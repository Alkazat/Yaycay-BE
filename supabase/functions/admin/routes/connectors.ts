// /admin/connectors - cross-account ops view over the BYO-AI OAuth grants
// (public.oauth_grants, the AS store from 0023_oauth_store). Admin lists every
// connected assistant and revokes any grant. Revoke is the incident-response
// kill switch: it stamps revoked_at and clears the issued-token hashes so the
// next /api/mcp call fails verification (verifyMcpToken rejects revoked grants).
// All admin+AAL2, audited. The grants table is service-role only, so every read
// here is via the service client.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

// assistant label lives on oauth_clients.client_name (embedded by the client_id FK).
const GRANT_SELECT =
  'id, user_id, client_id, scope, revoked_at, last_used_at, created_at, oauth_clients(client_name)';
const GRANT_SELECT_INNER =
  'id, user_id, client_id, scope, revoked_at, last_used_at, created_at, oauth_clients!inner(client_name)';

interface ClientEmbed {
  client_name: string | null;
}
interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  scope: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  oauth_clients: ClientEmbed | ClientEmbed[] | null;
}

function clientName(r: GrantRow): string {
  const c = Array.isArray(r.oauth_clients) ? r.oauth_clients[0] : r.oauth_clients;
  return c?.client_name ?? '';
}

async function emailsFor(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return map;
  const { data } = await serviceClient()
    .schema('identity')
    .from('accounts')
    .select('user_id, email')
    .in('user_id', ids);
  for (const a of data ?? []) map.set(a.user_id, a.email);
  return map;
}

function toAdminConnector(r: GrantRow, email: string | undefined) {
  return {
    id: r.id,
    userId: r.user_id,
    ownerEmail: email ?? '',
    assistant: clientName(r),
    clientId: r.client_id,
    // scope is space-delimited on the grant; expose as the contract's array.
    scopes: (r.scope ?? '').split(/\s+/).filter((s) => s.length > 0),
    status: r.revoked_at ? 'revoked' : 'active',
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export async function listConnectors(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);
  const db = serviceClient();

  let q;
  if (query && query.includes('@')) {
    // Owner-email search: resolve matching accounts to user_ids first.
    const { data: accts } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id')
      .ilike('email', `%${query}%`);
    const ids = (accts ?? []).map((a) => a.user_id as string);
    if (ids.length === 0) return ok(page([], params));
    q = db.from('oauth_grants').select(GRANT_SELECT).in('user_id', ids);
  } else if (query) {
    // Assistant-label search (inner join so the filter prunes parents).
    q = db
      .from('oauth_grants')
      .select(GRANT_SELECT_INNER)
      .ilike('oauth_clients.client_name', `%${query}%`);
  } else {
    q = db.from('oauth_grants').select(GRANT_SELECT);
  }

  const { data, error } = await q
    .order('created_at', { ascending: false })
    .range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = (data ?? []) as GrantRow[];
  const emails = await emailsFor(rows.map((r) => r.user_id));
  return ok(
    page(
      rows.map((r) => toAdminConnector(r, emails.get(r.user_id))),
      params,
    ),
  );
}

export async function revokeConnector(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from('oauth_grants')
    .select('id, revoked_at')
    .eq('id', id)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) throw notFound('Connector grant not found.');

  // Effective immediately: stamp revoked_at and clear the issued-token hashes so
  // verifyMcpToken (which looks grants up by token hash and rejects revoked) can
  // never match a previously-issued token again.
  const { error } = await db
    .from('oauth_grants')
    .update({
      revoked_at: new Date().toISOString(),
      access_token_hash: null,
      refresh_token_hash: null,
    })
    .eq('id', id);
  if (error) throw badRequest(error.message);

  const { data, error: reErr } = await db
    .from('oauth_grants')
    .select(GRANT_SELECT)
    .eq('id', id)
    .single();
  if (reErr) throw badRequest(reErr.message);

  const emails = await emailsFor([(data as GrantRow).user_id]);
  await writeAudit(ctx, {
    action: 'connector.revoke',
    targetType: 'oauth_grant',
    targetId: id,
    before: {
      status: (existing as { revoked_at: string | null }).revoked_at ? 'revoked' : 'active',
    },
    after: { status: 'revoked' },
  });
  return ok(toAdminConnector(data as GrantRow, emails.get((data as GrantRow).user_id)));
}
