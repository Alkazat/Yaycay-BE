// /admin/support-sessions - time-boxed, reason-gated, audited "view-as".
//
// A support session lets an admin inspect ONE customer's data for a short
// window. It is an oversight record, not a credential: nothing here mints a
// customer login link, access/refresh token, or auth cookie. Reads go through
// the same service-role path the other /admin/* read endpoints use; the session
// scopes that access to one customer, time-boxes it, records the reason, and
// audits every snapshot fetch. Acting AS the customer (writes) is out of scope.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable, conflict, gone, forbidden } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 120;

interface SessionRow {
  id: string;
  actor_id: string;
  actor_email: string | null;
  target_user_id: string;
  target_email: string | null;
  reason: string;
  mode: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
}

function isActive(r: SessionRow): boolean {
  return r.ended_at == null && new Date(r.expires_at).getTime() > Date.now();
}

function toSession(r: SessionRow) {
  return {
    id: r.id,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    targetUserId: r.target_user_id,
    targetEmail: r.target_email,
    reason: r.reason,
    mode: r.mode,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
    endedAt: r.ended_at,
    endedReason: r.ended_reason,
    active: isActive(r),
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

const SELECT = 'id, actor_id, actor_email, target_user_id, target_email, reason, mode, started_at, expires_at, ended_at, ended_reason';

// Best-known tier + latest retention across a customer's trips (mirrors the
// /admin/customers entitlement derivation).
async function entitlement(
  db: ReturnType<typeof serviceClient>,
  userId: string,
): Promise<{ tier: string | null; retentionExpiresAt: string | null }> {
  const { data } = await db
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

// POST /admin/support-sessions - open a session for one customer.
export async function startSupportSession(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readBody(req);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw unprocessable('A reason (e.g. a support ticket reference) is required.');

  const db = serviceClient();

  // Resolve the customer by id or email against the isolated identity store.
  let target: { user_id: string; email: string } | null = null;
  if (typeof body.targetUserId === 'string' && body.targetUserId) {
    const { data } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id, email')
      .eq('user_id', body.targetUserId)
      .maybeSingle();
    target = data ?? null;
  } else if (typeof body.targetEmail === 'string' && body.targetEmail) {
    const { data } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id, email')
      .ilike('email', body.targetEmail.trim())
      .maybeSingle();
    target = data ?? null;
  } else {
    throw unprocessable('targetUserId or targetEmail is required.');
  }
  if (!target) throw notFound('Customer not found.');

  // An admin should never inspect themselves through this surface, and one open
  // session per admin keeps the active view-as unambiguous.
  if (target.user_id === ctx.actorId) {
    throw unprocessable('You cannot open a support session against your own account.');
  }
  const { data: open } = await db
    .from('support_sessions')
    .select('id')
    .eq('actor_id', ctx.actorId)
    .is('ended_at', null)
    .maybeSingle();
  if (open) {
    throw conflict('You already have an open support session. End it before starting another.');
  }

  let ttl = typeof body.ttlMinutes === 'number' ? Math.floor(body.ttlMinutes) : DEFAULT_TTL_MIN;
  if (!Number.isFinite(ttl) || ttl < 1) ttl = DEFAULT_TTL_MIN;
  if (ttl > MAX_TTL_MIN) ttl = MAX_TTL_MIN;
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

  const { data, error } = await db
    .from('support_sessions')
    .insert({
      actor_id: ctx.actorId,
      actor_email: ctx.email,
      target_user_id: target.user_id,
      target_email: target.email,
      reason,
      mode: 'read_only',
      expires_at: expiresAt,
    })
    .select(SELECT)
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'support.start',
    targetType: 'account',
    targetId: target.user_id,
    after: { sessionId: data.id, reason, expiresAt },
  });
  return ok(toSession(data as SessionRow), 201);
}

// GET /admin/support-sessions[?active=true] - list sessions for oversight.
export async function listSupportSessions(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const activeOnly = url.searchParams.get('active') === 'true';
  const params = parsePageParams(url);

  let q = serviceClient()
    .from('support_sessions')
    .select(SELECT)
    .order('started_at', { ascending: false });
  if (activeOnly) q = q.is('ended_at', null).gt('expires_at', new Date().toISOString());

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  return ok(page((data as SessionRow[]).map(toSession), params));
}

// GET /admin/support-sessions/{id}
export async function getSupportSession(
  _req: Request,
  _ctx: AdminContext,
  id: string,
): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('support_sessions')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Support session not found.');
  return ok(toSession(data as SessionRow));
}

// POST /admin/support-sessions/{id}/end - close an open session.
export async function endSupportSession(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: existing } = await db
    .from('support_sessions')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw notFound('Support session not found.');
  if ((existing as SessionRow).ended_at) return ok(toSession(existing as SessionRow));

  const { data, error } = await db
    .from('support_sessions')
    .update({ ended_at: new Date().toISOString(), ended_reason: 'manual' })
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'support.end',
    targetType: 'account',
    targetId: (data as SessionRow).target_user_id,
    after: { sessionId: id, endedReason: 'manual' },
  });
  return ok(toSession(data as SessionRow));
}

// GET /admin/support-sessions/{id}/snapshot - read-only customer footprint.
// Only the owning admin, only while the session is active. Audited per fetch.
export async function getSupportSessionSnapshot(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: sess } = await db
    .from('support_sessions')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!sess) throw notFound('Support session not found.');
  const row = sess as SessionRow;

  // Least privilege: a session's snapshot is readable only by the admin who
  // opened it. Other admins see it through the list view for oversight.
  if (row.actor_id !== ctx.actorId) {
    throw forbidden('This support session belongs to another admin.');
  }
  if (row.ended_at) throw gone('This support session has ended.');
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    // Lazily close an expired session so its state is accurate.
    await db
      .from('support_sessions')
      .update({ ended_at: new Date().toISOString(), ended_reason: 'expired' })
      .eq('id', id)
      .is('ended_at', null);
    throw gone('This support session has expired. Start a new one to continue.');
  }

  const uid = row.target_user_id;
  const [acct, ent, profilesRes, tripsRes] = await Promise.all([
    db.schema('identity').from('accounts').select('user_id, email, deletion_requested_at').eq('user_id', uid).maybeSingle(),
    entitlement(db, uid),
    db.from('child_profiles').select('id, name, age, type, pin_hash, interests, medical').eq('user_id', uid),
    db.from('trips').select('id, destination, tier, status, start_date, end_date, retention_expires_at').eq('user_id', uid).order('created_at', { ascending: false }),
  ]);

  const account = acct.data;
  if (!account) throw notFound('Customer not found.');

  const customer = {
    userId: account.user_id,
    email: account.email,
    tier: ent.tier,
    retentionExpiresAt: ent.retentionExpiresAt,
    deletionRequested: account.deletion_requested_at != null,
  };
  const profiles = (profilesRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    age: p.age ?? 0,
    type: p.type ?? 'child',
    pin_set: p.pin_hash != null,
    interests: p.interests ?? [],
    ...(Array.isArray(p.medical) && p.medical.length > 0 ? { medical: p.medical } : {}),
  }));
  const trips = (tripsRes.data ?? []).map((t) => ({
    id: t.id,
    destination: t.destination,
    ownerEmail: account.email,
    tier: t.tier,
    status: t.status,
    startDate: t.start_date ?? '',
    endDate: t.end_date ?? '',
    retentionExpiresAt: t.retention_expires_at,
  }));

  // Every look at customer data under a session is audited against the target.
  await writeAudit(ctx, {
    action: 'support.read',
    targetType: 'account',
    targetId: uid,
    after: { sessionId: id },
  });

  return ok({ session: toSession(row), customer, profiles, trips });
}
