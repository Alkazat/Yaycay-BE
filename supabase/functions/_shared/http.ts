// Shared HTTP helpers for Yaycay edge functions (Deno runtime).

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: string[] };
}

export function error(code: string, message: string, status: number, details?: string[]): Response {
  const body: ApiErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return json(body, status);
}

/** Standard preflight handling; returns a Response for OPTIONS, else null. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}
