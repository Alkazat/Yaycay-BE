// /admin/trips - read-only trip inspection. Owner email is resolved from the
// isolated identity store and joined in memory (cross-schema, by user_id).

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

interface TripRow {
  id: string;
  user_id: string;
  destination: string;
  start_date: string | null;
  end_date: string | null;
  tier: string;
  status: string;
  retention_expires_at: string | null;
}

async function emailsFor(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const { data } = await serviceClient()
    .schema('identity')
    .from('accounts')
    .select('user_id, email')
    .in('user_id', [...new Set(userIds)]);
  for (const a of data ?? []) map.set(a.user_id, a.email);
  return map;
}

function toSummary(r: TripRow, email: string | undefined) {
  return {
    id: r.id,
    destination: r.destination,
    ownerEmail: email ?? '',
    tier: r.tier,
    status: r.status,
    startDate: r.start_date ?? '',
    endDate: r.end_date ?? '',
    retentionExpiresAt: r.retention_expires_at,
  };
}

export async function searchTrips(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);
  const db = serviceClient();

  let q = db.from('trips').select('*').order('created_at', { ascending: false });
  if (query.includes('@')) {
    // Email search: resolve matching accounts to user_ids first.
    const { data: accts } = await db
      .schema('identity')
      .from('accounts')
      .select('user_id')
      .ilike('email', `%${query}%`);
    const ids = (accts ?? []).map((a) => a.user_id);
    if (ids.length === 0) return ok(page([], params));
    q = q.in('user_id', ids);
  } else if (query) {
    q = q.or(`destination.ilike.%${query}%,id.eq.${query}`);
  }

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = data as TripRow[];
  const emails = await emailsFor(rows.map((r) => r.user_id));
  return ok(
    page(
      rows.map((r) => toSummary(r, emails.get(r.user_id))),
      params,
    ),
  );
}

export async function getTripSummary(
  _req: Request,
  _ctx: AdminContext,
  id: string,
): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('trips')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Trip not found.');
  const emails = await emailsFor([data.user_id]);
  return ok(toSummary(data as TripRow, emails.get(data.user_id)));
}

export async function getTripContent(
  _req: Request,
  _ctx: AdminContext,
  id: string,
): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('trip_content')
    .select('content')
    .eq('trip_id', id)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Trip content not found.');
  return ok(data.content);
}

export async function getTripProfiles(
  _req: Request,
  _ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: trip } = await db.from('trips').select('user_id').eq('id', id).maybeSingle();
  if (!trip) throw notFound('Trip not found.');
  const { data, error } = await db
    .from('child_profiles')
    .select('id, name, age, mode, type, pin_hash, interests')
    .eq('user_id', trip.user_id);
  if (error) throw badRequest(error.message);
  return ok({
    items: (data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.age != null ? { age: p.age } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
      type: p.type ?? 'child',
      pin_set: p.pin_hash != null,
      interests: p.interests ?? [],
    })),
  });
}

async function tripOwner(db: ReturnType<typeof serviceClient>, id: string): Promise<string> {
  const { data: trip } = await db.from('trips').select('user_id').eq('id', id).maybeSingle();
  if (!trip) throw notFound('Trip not found.');
  return trip.user_id as string;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

const CHAT_COLUMNS = 'id, role, kind, content, meta, seq, created_at';
const COMPANION_COLUMNS = 'id, near_label, prompt, options, rain_plan, created_at';

// Replace the trip's planning-chat history (admin upload / fixture load).
export async function uploadTripChat(
  req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const ownerId = await tripOwner(db, id);
  const body = await readBody(req);
  const messages = Array.isArray(body.messages)
    ? (body.messages as Record<string, unknown>[])
    : null;
  if (!messages) throw unprocessable('messages[] is required');

  const rows = messages.map((m, i) => ({
    trip_id: id,
    user_id: ownerId,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    kind: m.kind === 'import_chip' ? 'import_chip' : 'text',
    content: typeof m.content === 'string' ? m.content : '',
    meta: m.meta ?? null,
    seq: Number.isInteger(m.seq) ? (m.seq as number) : i,
  }));

  const { error: delErr } = await db.from('trip_chat_messages').delete().eq('trip_id', id);
  if (delErr) throw badRequest(delErr.message);
  if (rows.length > 0) {
    const { error: insErr } = await db.from('trip_chat_messages').insert(rows);
    if (insErr) throw badRequest(insErr.message);
  }

  await writeAudit(ctx, {
    action: 'trip.chat.upload',
    targetType: 'trip',
    targetId: id,
    after: { count: rows.length },
  });
  const { data } = await db
    .from('trip_chat_messages')
    .select(CHAT_COLUMNS)
    .eq('trip_id', id)
    .order('seq', { ascending: true })
    .order('created_at', { ascending: true });
  return ok({ messages: data ?? [] });
}

// Replace the trip's companion cards (admin upload / fixture load).
export async function uploadTripCompanion(
  req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const ownerId = await tripOwner(db, id);
  const body = await readBody(req);
  const cards = Array.isArray(body.cards) ? (body.cards as Record<string, unknown>[]) : null;
  if (!cards) throw unprocessable('cards[] is required');

  const rows = cards.map((c) => ({
    trip_id: id,
    user_id: ownerId,
    near_label: typeof c.near_label === 'string' ? c.near_label : null,
    prompt: typeof c.prompt === 'string' ? c.prompt : null,
    options: Array.isArray(c.options) ? c.options : [],
    rain_plan: c.rain_plan ?? null,
  }));

  const { error: delErr } = await db.from('trip_companion_cards').delete().eq('trip_id', id);
  if (delErr) throw badRequest(delErr.message);
  if (rows.length > 0) {
    const { error: insErr } = await db.from('trip_companion_cards').insert(rows);
    if (insErr) throw badRequest(insErr.message);
  }

  await writeAudit(ctx, {
    action: 'trip.companion.upload',
    targetType: 'trip',
    targetId: id,
    after: { count: rows.length },
  });
  const { data } = await db
    .from('trip_companion_cards')
    .select(COMPANION_COLUMNS)
    .eq('trip_id', id)
    .order('created_at', { ascending: true });
  return ok({ cards: data ?? [] });
}

export async function getTripProgress(
  _req: Request,
  _ctx: AdminContext,
  id: string,
): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('trip_progress')
    .select('profile_id, active_mode, done_items')
    .eq('trip_id', id);
  if (error) throw badRequest(error.message);
  return ok({
    items: (data ?? []).map((p) => ({
      profileId: p.profile_id,
      activeMode: p.active_mode,
      doneItems: p.done_items ?? [],
    })),
  });
}

const TRIP_TIERS = ['ours', 'byo'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create a trip for a customer with the tier entitlement granted directly
 * (POST /admin/trips). Admin-only: skips Stripe. The owner must already exist
 * (invite first). Returns the AdminTripSummary, 201.
 */
export async function createTrip(req: Request, ctx: AdminContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }

  const ownerEmail =
    typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
  const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
  const tier = String(body.tier ?? '');
  const startDate = typeof body.startDate === 'string' ? body.startDate : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate : '';

  const errs: string[] = [];
  if (!EMAIL_RE.test(ownerEmail)) errs.push('ownerEmail must be a valid email');
  if (!destination) errs.push('destination is required');
  if (!TRIP_TIERS.includes(tier)) errs.push("tier must be 'ours' or 'byo'");
  if (!ISO_DATE_RE.test(startDate)) errs.push('startDate must be an ISO date (YYYY-MM-DD)');
  if (!ISO_DATE_RE.test(endDate)) errs.push('endDate must be an ISO date (YYYY-MM-DD)');
  if (ISO_DATE_RE.test(startDate) && ISO_DATE_RE.test(endDate) && endDate < startDate) {
    errs.push('endDate must be on or after startDate');
  }
  if (errs.length) throw unprocessable(errs.join('; '));

  const db = serviceClient();
  const { data: acct, error: acctErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email')
    .ilike('email', ownerEmail)
    .maybeSingle();
  if (acctErr) throw badRequest(acctErr.message);
  if (!acct) throw unprocessable(`No Yaycay account for ${ownerEmail} - invite them first.`);

  const { data: trip, error: insErr } = await db
    .from('trips')
    .insert({
      user_id: acct.user_id,
      destination,
      tier,
      start_date: startDate,
      end_date: endDate,
      status: 'planning',
    })
    .select('*')
    .single();
  if (insErr) throw badRequest(insErr.message);

  await writeAudit(ctx, {
    action: 'trip.create',
    targetType: 'trip',
    targetId: trip.id as string,
    after: { ownerEmail: acct.email, destination, tier, startDate, endDate },
  });
  return ok(toSummary(trip as TripRow, acct.email as string), 201);
}

/** Delete a trip (DELETE /admin/trips/{id}); content/journal cascade. */
export async function deleteTrip(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: trip, error: selErr } = await db
    .from('trips')
    .select('id, destination')
    .eq('id', id)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!trip) throw notFound('Trip not found.');

  const { error: delErr } = await db.from('trips').delete().eq('id', id);
  if (delErr) throw badRequest(delErr.message);

  await writeAudit(ctx, {
    action: 'trip.delete',
    targetType: 'trip',
    targetId: id,
    before: { destination: trip.destination },
  });
  return ok({ deleted: true });
}
