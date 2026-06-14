// /admin/deletion-requests - the data-deletion (GDPR) console.
//
// Surfaces accounts that have asked to be deleted (user-side
// POST /account/deletion-request, or an admin via /admin/customers), lets an
// admin verify the data footprint, cancel a request, or execute a hard delete.
//
// Policy (see the FE/admin thread): execution is MANUAL only (no auto-cron),
// blocked until a 30-day grace window has elapsed unless force:true, and is a
// hard delete - we remove the auth user, which cascades trips/journal/profiles;
// purchases survive anonymized (purchases.user_id is on-delete-set-null).
// Every action is audited.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable, ProblemError } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const GRACE_DAYS = 30;
const DAY_MS = 86_400_000;

interface AccountRow {
  user_id: string;
  email: string;
  deletion_requested_at: string | null;
}

interface Footprint {
  tier: string | null;
  trips: number;
  media: number;
  purchases: number;
}

type Db = ReturnType<typeof serviceClient>;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

// What an execute would erase. Trips carry the tier; media/purchases are counted
// by owner. (Journal/profiles cascade from trips and are not counted here.)
async function footprint(db: Db, userId: string): Promise<Footprint> {
  const { data: tripRows } = await db.from('trips').select('tier').eq('user_id', userId);
  let tier: string | null = null;
  for (const t of tripRows ?? []) {
    if (t.tier === 'ours' || t.tier === 'byo') tier = t.tier as string;
    else if (tier === null) tier = (t.tier as string) ?? null;
  }
  const headCount = async (table: string): Promise<number> => {
    const { count } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    return count ?? 0;
  };
  const [media, purchases] = await Promise.all([headCount('media_assets'), headCount('purchases')]);
  return { tier, trips: tripRows?.length ?? 0, media, purchases };
}

function toRequest(a: AccountRow, fp: Footprint) {
  const requestedAt = a.deletion_requested_at as string;
  const reqMs = new Date(requestedAt).getTime();
  const eligibleMs = reqMs + GRACE_DAYS * DAY_MS;
  return {
    userId: a.user_id,
    email: a.email,
    requestedAt,
    ageDays: Math.floor((Date.now() - reqMs) / DAY_MS),
    eligibleAt: new Date(eligibleMs).toISOString(),
    eligible: Date.now() >= eligibleMs,
    tier: fp.tier,
    trips: fp.trips,
    media: fp.media,
    purchases: fp.purchases,
  };
}

export async function listDeletionRequests(req: Request, _ctx: AdminContext): Promise<Response> {
  const params = parsePageParams(new URL(req.url));
  const db = serviceClient();
  const { data, error } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .not('deletion_requested_at', 'is', null)
    .order('deletion_requested_at', { ascending: true })
    .range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = (data ?? []) as AccountRow[];
  const items = await Promise.all(
    rows.map(async (a) => toRequest(a, await footprint(db, a.user_id))),
  );
  return ok(page(items, params));
}

async function loadRequested(db: Db, userId: string): Promise<AccountRow> {
  const { data, error } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Account not found.');
  if (!(data as AccountRow).deletion_requested_at) {
    throw notFound('No deletion request on file for this account.');
  }
  return data as AccountRow;
}

export async function getDeletionRequest(
  _req: Request,
  _ctx: AdminContext,
  userId: string,
): Promise<Response> {
  const db = serviceClient();
  const acct = await loadRequested(db, userId);
  return ok(toRequest(acct, await footprint(db, userId)));
}

export async function cancelDeletionRequest(
  _req: Request,
  ctx: AdminContext,
  userId: string,
): Promise<Response> {
  const db = serviceClient();
  const acct = await loadRequested(db, userId);
  const { error } = await db
    .schema('identity')
    .from('accounts')
    .update({ deletion_requested_at: null })
    .eq('user_id', userId);
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'account.deletion.cancel',
    targetType: 'account',
    targetId: userId,
    before: { deletion_requested_at: acct.deletion_requested_at },
    after: { deletion_requested_at: null },
  });
  return ok({ userId, email: acct.email, cancelled: true });
}

export async function executeDeletion(
  req: Request,
  ctx: AdminContext,
  userId: string,
): Promise<Response> {
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const force = body.force === true;

  const db = serviceClient();
  const acct = await loadRequested(db, userId);

  // Confirm-by-typing: the admin must echo the exact account email.
  if (!email || email.toLowerCase() !== acct.email.toLowerCase()) {
    throw unprocessable('Confirmation email does not match the account.');
  }

  // Grace-period guard unless explicitly overridden.
  const eligibleMs = new Date(acct.deletion_requested_at as string).getTime() + GRACE_DAYS * DAY_MS;
  if (!force && Date.now() < eligibleMs) {
    throw new ProblemError(
      409,
      'Conflict',
      `Within the ${GRACE_DAYS}-day grace period (eligible ${new Date(eligibleMs).toISOString()}). Send force:true to override.`,
    );
  }

  // Snapshot before the irreversible delete.
  const fp = await footprint(db, userId);

  // Hard delete: removing the auth user cascades the owned rows.
  const { error: delErr } = await db.auth.admin.deleteUser(userId);
  if (delErr) throw badRequest(delErr.message);

  await writeAudit(ctx, {
    action: 'account.deletion.execute',
    targetType: 'account',
    targetId: userId,
    before: {
      email: acct.email,
      deletion_requested_at: acct.deletion_requested_at,
      footprint: fp,
      forced: force,
    },
  });
  return ok({ deleted: true, userId, email: acct.email, footprint: fp });
}
