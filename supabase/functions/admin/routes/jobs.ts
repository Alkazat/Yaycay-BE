// /admin/jobs - inspect, retry, and check the daily cap of AI jobs.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, ProblemError } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const DAILY_CAP = 10;

interface JobRow {
  id: string;
  trip_id: string | null;
  kind: string;
  status: string;
  model: string | null;
  prompt_version: string | null;
  error: string | null;
  created_at: string;
}

function toDto(r: JobRow) {
  return {
    id: r.id,
    tripId: r.trip_id ?? '',
    kind: r.kind,
    status: r.status,
    model: r.model ?? 'claude-sonnet',
    promptVersion: r.prompt_version ? Number(r.prompt_version) || 0 : 0,
    createdAt: r.created_at,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function listJobs(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const params = parsePageParams(url);
  let q = serviceClient().from('ai_jobs').select('*').order('created_at', { ascending: false });

  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  const tripId = url.searchParams.get('tripId');
  if (status) q = q.eq('status', status);
  if (kind) q = q.eq('kind', kind);
  if (tripId) q = q.eq('trip_id', tripId);

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  return ok(page((data as JobRow[]).map(toDto), params));
}

export async function getJob(_req: Request, _ctx: AdminContext, id: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('ai_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Job not found.');
  return ok(toDto(data as JobRow));
}

export async function retryJob(_req: Request, ctx: AdminContext, id: string): Promise<Response> {
  const db = serviceClient();
  const { data: job, error } = await db.from('ai_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw badRequest(error.message);
  if (!job) throw notFound('Job not found.');

  if (job.trip_id) {
    const used = await capUsed(job.trip_id);
    if (used >= DAILY_CAP) {
      throw new ProblemError(
        429,
        'Daily cap reached',
        `This trip has used its ${DAILY_CAP} AI updates for today. Retry tomorrow.`,
      );
    }
  }

  const { data: requeued, error: insErr } = await db
    .from('ai_jobs')
    .insert({
      user_id: job.user_id,
      trip_id: job.trip_id,
      kind: job.kind,
      status: 'queued',
      model: job.model,
      prompt_version: job.prompt_version,
    })
    .select('*')
    .single();
  if (insErr) throw badRequest(insErr.message);
  await writeAudit(ctx, {
    action: 'job.retry',
    targetType: 'ai_job',
    targetId: id,
    after: { requeuedAs: requeued.id },
  });
  return ok(toDto(requeued as JobRow), 202);
}

export async function getJobCap(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) throw badRequest('tripId is required');
  const used = await capUsed(tripId);
  return ok({
    tripId,
    date: new Date().toISOString().slice(0, 10),
    used,
    limit: DAILY_CAP,
    remaining: Math.max(0, DAILY_CAP - used),
  });
}

// Count today's (UTC) jobs for a trip.
async function capUsed(tripId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await serviceClient()
    .from('ai_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('trip_id', tripId)
    .gte('created_at', startOfDay.toISOString());
  if (error) throw badRequest(error.message);
  return count ?? 0;
}
