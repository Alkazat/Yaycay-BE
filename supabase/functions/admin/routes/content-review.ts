// /admin/content-review - approve or edit-then-publish generated content.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import { validateTripContent } from '../lib/validate-trip-content.ts';
import type { AdminContext } from '../lib/auth.ts';

interface ReviewRow {
  trip_id: string;
  status: string;
  generated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  trips?: { destination: string } | null;
}

function toDto(r: ReviewRow) {
  return {
    tripId: r.trip_id,
    destination: r.trips?.destination ?? '',
    status: r.status,
    generatedAt: r.generated_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
  };
}

export async function listContentReview(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const params = parsePageParams(url);
  const { data, error } = await serviceClient()
    .from('content_review')
    .select('trip_id, status, generated_at, reviewed_at, reviewed_by, trips(destination)')
    .eq('status', 'pending')
    .order('generated_at', { ascending: true })
    .range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  return ok(page((data as ReviewRow[]).map(toDto), params));
}

async function fetchReview(tripId: string): Promise<ReviewRow> {
  const { data, error } = await serviceClient()
    .from('content_review')
    .select('trip_id, status, generated_at, reviewed_at, reviewed_by, trips(destination)')
    .eq('trip_id', tripId)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('No content awaiting review for this trip.');
  return data as ReviewRow;
}

export async function approveContent(
  _req: Request,
  ctx: AdminContext,
  tripId: string,
): Promise<Response> {
  const before = await fetchReview(tripId);
  const { data, error } = await serviceClient()
    .from('content_review')
    .update({ status: 'approved', reviewed_by: ctx.actorId, reviewed_at: new Date().toISOString() })
    .eq('trip_id', tripId)
    .select('trip_id, status, generated_at, reviewed_at, reviewed_by, trips(destination)')
    .single();
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'content_review.approve',
    targetType: 'trip',
    targetId: tripId,
    before,
    after: data,
  });
  return ok(toDto(data as ReviewRow));
}

export async function editContent(
  req: Request,
  ctx: AdminContext,
  tripId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest('Request body must be JSON.');
  }
  const errors = validateTripContent(body);
  if (errors.length > 0) throw unprocessable(errors.join('; '));

  const before = await fetchReview(tripId);
  const db = serviceClient();

  // Persist the edited content, then mark the review edited+published.
  const { error: contentErr } = await db
    .from('trip_content')
    .update({ content: body })
    .eq('trip_id', tripId);
  if (contentErr) throw badRequest(contentErr.message);

  const { data, error } = await db
    .from('content_review')
    .update({ status: 'edited', reviewed_by: ctx.actorId, reviewed_at: new Date().toISOString() })
    .eq('trip_id', tripId)
    .select('trip_id, status, generated_at, reviewed_at, reviewed_by, trips(destination)')
    .single();
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'content_review.edit',
    targetType: 'trip',
    targetId: tripId,
    before,
    after: { status: 'edited' },
  });
  return ok(toDto(data as ReviewRow));
}
