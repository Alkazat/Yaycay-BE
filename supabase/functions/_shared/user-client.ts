// User-scoped Supabase client for the customer-facing edge functions. Unlike
// the admin path (service role), these run as the authenticated caller by
// forwarding the request's JWT, so Row-Level Security enforces ownership.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { optionalEnv, requireEnv } from './env.ts';

export interface UserContext {
  client: SupabaseClient;
  userId: string;
}

/**
 * Build a client bound to the caller's JWT and resolve the user id. Throws a
 * Response-bearing error code string when unauthenticated (callers map it to
 * 401).
 */
export async function userContext(req: Request): Promise<UserContext> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const client = createClient(
    requireEnv('SUPABASE_URL'),
    optionalEnv('SUPABASE_ANON_KEY') ?? requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    },
  );

  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) throw new UnauthorizedError('Missing bearer token.');

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new UnauthorizedError('Invalid or expired session.');

  return { client, userId: data.user.id };
}

export class UnauthorizedError extends Error {}
