// HTTP helpers for the admin function: CORS, JSON ok responses, and RFC 9457
// problem+json errors (the error shape every /admin/* endpoint returns).

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

/** An error thrown by handlers; the router renders it as problem+json. */
export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;

  constructor(status: number, title: string, detail?: string, type = 'about:blank') {
    super(title);
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = type;
  }
}

export function problem(err: ProblemError): Response {
  const body: Problem = {
    type: err.type,
    title: err.title,
    status: err.status,
    ...(err.detail ? { detail: err.detail } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: { ...corsHeaders, 'content-type': 'application/problem+json' },
  });
}

export const forbidden = (detail: string) => new ProblemError(403, 'Forbidden', detail);
export const notFound = (detail = 'Resource not found.') =>
  new ProblemError(404, 'Not Found', detail);
export const badRequest = (detail: string) => new ProblemError(400, 'Bad Request', detail);
export const unprocessable = (detail: string) =>
  new ProblemError(422, 'Unprocessable Entity', detail);
export const conflict = (detail: string) => new ProblemError(409, 'Conflict', detail);
export const gone = (detail: string) => new ProblemError(410, 'Gone', detail);
