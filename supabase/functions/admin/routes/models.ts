// /admin/models and /admin/model-routes - the model catalogue and per-task
// routing. Default for the use-our-AI tier is claude-sonnet.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import type { AdminContext } from '../lib/auth.ts';

const MODELS = ['claude-sonnet', 'claude-opus', 'gemini', 'openai'] as const;

// Capability matrix for the supported models.
const CATALOGUE = [
  { model: 'claude-sonnet', vision: true, streaming: true },
  { model: 'claude-opus', vision: true, streaming: true },
  { model: 'gemini', vision: true, streaming: true },
  { model: 'openai', vision: true, streaming: true },
];

export function listModels(_req: Request, _ctx: AdminContext): Response {
  return ok({ items: CATALOGUE });
}

interface RouteRow {
  task: string;
  default_model: string;
  override: string | null;
}

function toDto(r: RouteRow) {
  return {
    task: r.task,
    defaultModel: r.default_model,
    ...(r.override ? { override: r.override } : {}),
  };
}

export async function listModelRoutes(_req: Request, _ctx: AdminContext): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('model_routes')
    .select('*')
    .order('task', { ascending: true });
  if (error) throw badRequest(error.message);
  return ok({ items: (data as RouteRow[]).map(toDto) });
}

export async function setModelRoute(
  req: Request,
  ctx: AdminContext,
  task: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
  const defaultModel = body.defaultModel;
  if (
    typeof defaultModel !== 'string' ||
    !MODELS.includes(defaultModel as (typeof MODELS)[number])
  ) {
    throw unprocessable('defaultModel must be a known model');
  }
  const override = body.override ?? null;
  if (override !== null && !MODELS.includes(override as (typeof MODELS)[number])) {
    throw unprocessable('override must be a known model or null');
  }

  const { data, error } = await serviceClient()
    .from('model_routes')
    .upsert({ task, default_model: defaultModel, override }, { onConflict: 'task' })
    .select('*')
    .single();
  if (error) throw badRequest(error.message);
  await writeAudit(ctx, {
    action: 'model_route.set',
    targetType: 'model_route',
    targetId: task,
    after: data,
  });
  return ok(toDto(data as RouteRow));
}
