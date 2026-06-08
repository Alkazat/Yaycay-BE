// /admin/trips - read-only trip inspection. Owner email is resolved from the
// isolated identity store and joined in memory (cross-schema, by user_id).

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound } from '../lib/http.ts';
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
    .select('id, name, age, mode')
    .eq('user_id', trip.user_id);
  if (error) throw badRequest(error.message);
  return ok({
    items: (data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.age != null ? { age: p.age } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
    })),
  });
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
