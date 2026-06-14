// /admin/connectors - cross-account ops view over the BYO-AI MCP OAuth grants
// (public.oauth_grants). Admin lists every connected assistant and revokes any
// grant. Revoke is the incident-response kill switch: it flips status, stamps
// revoked_at, and bumps token_version so previously-issued tokens fail
// verification on the next /api/mcp call. All admin+AAL2, audited.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const GRANT_COLUMNS =
  'id, user_id, client_id, assistant, scopes, status, token_version, last_used_at, created_at';

interface GrantRow {
  id: string;
  user_id: string;
  client_id: string;
  assistant: string;
  scopes: string[] | null;
  status: string;
  token_version: number;
  last_used_at: string | null;
  created_at: string;
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
    assistant: r.assistant,
    clientId: r.client_id,
    scopes: r.scopes ?? [],
    status: r.status,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export async function listConnectors(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);
  const db = serviceClient();

  let q = db.from('oauth_grants').select(GRANT_COLUMNS).order('created_at', { ascending: false });
  if (query) {
    // Match by assistant label or by owner email (resolved to user_ids).
    const { data: accts } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id')
      .ilike('email', `%${query}%`);
    const ids = (accts ?? []).map((a) => a.user_id as string);
    q =
      ids.length > 0
        ? q.or(`assistant.ilike.%${query}%,user_id.in.(${ids.join(',')})`)
        : q.ilike('assistant', `%${query}%`);
  }

  const { data, error } = await q.range(params.offset, rangeEnd(params));
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
    .select(GRANT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) throw notFound('Connector grant not found.');

  const { data, error } = await db
    .from('oauth_grants')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      // Bump so any token minted at the old version fails verification.
      token_version: (existing as GrantRow).token_version + 1,
    })
    .eq('id', id)
    .select(GRANT_COLUMNS)
    .single();
  if (error) throw badRequest(error.message);

  const emails = await emailsFor([(data as GrantRow).user_id]);
  await writeAudit(ctx, {
    action: 'connector.revoke',
    targetType: 'oauth_grant',
    targetId: id,
    before: { status: (existing as GrantRow).status },
    after: { status: 'revoked' },
  });
  return ok(toAdminConnector(data as GrantRow, emails.get((data as GrantRow).user_id)));
}
