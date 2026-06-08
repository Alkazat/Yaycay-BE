// /admin/prompts - the versioned prompt harness. Versions are immutable;
// editing creates a new version. Exactly one active version per task.

import { serviceClient } from '../lib/db.ts';
import { ok, notFound, badRequest, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';

const MODELS = ['claude-sonnet', 'claude-opus', 'gemini', 'openai'];

interface PromptRow {
  id: string;
  task: string;
  title: string;
  body: string;
  model: string;
  version: number;
  active: boolean;
  updated_by: string | null;
  updated_at: string;
}

function toDto(r: PromptRow) {
  return {
    id: r.id,
    task: r.task,
    title: r.title,
    body: r.body,
    model: r.model,
    version: r.version,
    active: r.active,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ?? '',
  };
}

export async function listPrompts(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const task = url.searchParams.get('task');
  const params = parsePageParams(url);
  const db = serviceClient();

  if (task) {
    // All versions for one task, newest first.
    const { data, error } = await db
      .from('prompts')
      .select('*')
      .eq('task', task)
      .order('version', { ascending: false })
      .range(params.offset, rangeEnd(params));
    if (error) throw badRequest(error.message);
    return ok(page((data as PromptRow[]).map(toDto), params));
  }

  // Latest version per task. Fetch ordered, reduce, then paginate in memory.
  const { data, error } = await db
    .from('prompts')
    .select('*')
    .order('task', { ascending: true })
    .order('version', { ascending: false });
  if (error) throw badRequest(error.message);
  const latestByTask = new Map<string, PromptRow>();
  for (const row of data as PromptRow[]) {
    if (!latestByTask.has(row.task)) latestByTask.set(row.task, row);
  }
  const all = [...latestByTask.values()].map(toDto);
  const slice = all.slice(params.offset, params.offset + params.limit);
  return ok(page(slice, params));
}

export async function getPrompt(_req: Request, _ctx: AdminContext, id: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('prompts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Prompt not found.');
  return ok(toDto(data as PromptRow));
}

export async function createPrompt(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readJson(req);
  for (const f of ['task', 'title', 'body', 'model'] as const) {
    if (typeof body[f] !== 'string' || (body[f] as string).length === 0) {
      throw unprocessable(`${f} is required`);
    }
  }
  if (!MODELS.includes(body.model as string)) throw unprocessable('unknown model');
  const db = serviceClient();

  // First version of a task becomes active; otherwise it starts inactive.
  const { count } = await db
    .from('prompts')
    .select('id', { count: 'exact', head: true })
    .eq('task', body.task as string);
  const active = (count ?? 0) === 0;

  const { data, error } = await db
    .from('prompts')
    .insert({
      task: body.task,
      title: body.title,
      body: body.body,
      model: body.model,
      version: 1,
      active,
      updated_by: ctx.actorId,
    })
    .select('*')
    .single();
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'prompt.create',
    targetType: 'prompt',
    targetId: data.id,
    after: data,
  });
  return ok(toDto(data as PromptRow), 201);
}

export async function createPromptVersion(
  req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const body = await readJson(req);
  for (const f of ['title', 'body', 'model'] as const) {
    if (typeof body[f] !== 'string' || (body[f] as string).length === 0) {
      throw unprocessable(`${f} is required`);
    }
  }
  const db = serviceClient();
  const { data: base, error: baseErr } = await db
    .from('prompts')
    .select('task')
    .eq('id', id)
    .maybeSingle();
  if (baseErr) throw badRequest(baseErr.message);
  if (!base) throw notFound('Prompt not found.');

  const { data: maxRow } = await db
    .from('prompts')
    .select('version')
    .eq('task', base.task)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxRow?.version ?? 0) + 1;

  const { data, error } = await db
    .from('prompts')
    .insert({
      task: base.task,
      title: body.title,
      body: body.body,
      model: body.model,
      version: nextVersion,
      active: false,
      updated_by: ctx.actorId,
    })
    .select('*')
    .single();
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'prompt.version.create',
    targetType: 'prompt',
    targetId: data.id,
    after: data,
  });
  return ok(toDto(data as PromptRow), 201);
}

export async function activatePrompt(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: target, error } = await db.from('prompts').select('*').eq('id', id).maybeSingle();
  if (error) throw badRequest(error.message);
  if (!target) throw notFound('Prompt not found.');

  // Deactivate the task's current active version, then activate this one.
  const { error: deErr } = await db
    .from('prompts')
    .update({ active: false })
    .eq('task', target.task)
    .eq('active', true);
  if (deErr) throw badRequest(deErr.message);

  const { data, error: upErr } = await db
    .from('prompts')
    .update({ active: true })
    .eq('id', id)
    .select('*')
    .single();
  if (upErr) throw badRequest(upErr.message);
  await writeAudit(ctx, {
    action: 'prompt.activate',
    targetType: 'prompt',
    targetId: id,
    before: target,
    after: data,
  });
  return ok(toDto(data as PromptRow));
}

export async function diffPrompt(req: Request, _ctx: AdminContext, id: string): Promise<Response> {
  const url = new URL(req.url);
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw badRequest('from and to (integers) are required');
  }
  const db = serviceClient();
  const { data: base } = await db.from('prompts').select('task').eq('id', id).maybeSingle();
  if (!base) throw notFound('Prompt not found.');

  const { data: rows, error } = await db
    .from('prompts')
    .select('version, body')
    .eq('task', base.task)
    .in('version', [from, to]);
  if (error) throw badRequest(error.message);
  const byVersion = new Map<number, string>((rows ?? []).map((r) => [r.version, r.body]));
  if (!byVersion.has(from) || !byVersion.has(to)) throw notFound('Version not found.');

  return ok({ from, to, diff: lineDiff(byVersion.get(from)!, byVersion.get(to)!) });
}

// ----- helpers ---------------------------------------------------------------

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

// Minimal unified-style line diff (added/removed/unchanged markers).
function lineDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out: string[] = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] === bl[i]) {
      if (al[i] !== undefined) out.push(`  ${al[i]}`);
    } else {
      if (al[i] !== undefined) out.push(`- ${al[i]}`);
      if (bl[i] !== undefined) out.push(`+ ${bl[i]}`);
    }
  }
  return out.join('\n');
}
