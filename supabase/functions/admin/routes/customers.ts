// /admin/customers - account lookup, entitlement, retention, and deletion
// requests. Accounts live in the isolated identity store; tier and retention
// are derived from the customer's trips.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

interface AccountRow {
  user_id: string;
  email: string;
  deletion_requested_at: string | null;
}

// Derive the best-known tier and the latest retention date from the user's
// trips. A paid tier (ours/byo) wins over free.
async function entitlement(
  userId: string,
): Promise<{ tier: string | null; retentionExpiresAt: string | null }> {
  const { data } = await serviceClient()
    .from('trips')
    .select('tier, retention_expires_at')
    .eq('user_id', userId);
  let tier: string | null = null;
  let retention: string | null = null;
  for (const t of data ?? []) {
    if (t.tier === 'ours' || t.tier === 'byo') tier = t.tier;
    else if (tier === null) tier = t.tier;
    if (t.retention_expires_at && (!retention || t.retention_expires_at > retention)) {
      retention = t.retention_expires_at;
    }
  }
  return { tier, retentionExpiresAt: retention };
}

async function toSummary(a: AccountRow) {
  const ent = await entitlement(a.user_id);
  return {
    userId: a.user_id,
    email: a.email,
    tier: ent.tier,
    retentionExpiresAt: ent.retentionExpiresAt,
    deletionRequested: a.deletion_requested_at != null,
  };
}

export async function searchCustomers(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);

  let q = serviceClient()
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .order('email', { ascending: true });
  if (query) q = q.ilike('email', `%${query}%`);

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const items = await Promise.all((data as AccountRow[]).map(toSummary));
  return ok(page(items, params));
}

export async function requestCustomerDeletion(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data, error } = await db
    .schema('identity')
    .from('accounts')
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq('user_id', id)
    .select('user_id, email, deletion_requested_at')
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Customer not found.');
  await writeAudit(ctx, {
    action: 'customer.deletion_request',
    targetType: 'account',
    targetId: id,
    after: { deletion_requested_at: data.deletion_requested_at },
  });
  return ok(await toSummary(data as AccountRow));
}
