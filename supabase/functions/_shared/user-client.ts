// User-scoped Supabase client for the customer-facing edge functions. Unlike
// the admin path (service role), these run as the authenticated caller by
// forwarding the request's JWT, so Row-Level Security enforces ownership.
//
// SECURITY: this client MUST be built with the anon key, never the service-role
// key. The service role has BYPASSRLS in Postgres, which means RLS policies are
// completely ignored and every query returns all rows across all accounts. The
// anon key is safe to forward to end-users and respects RLS correctly.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { requireEnv } from './env.ts';

export interface UserContext {
  client: SupabaseClient;
  userId: string;
}

/**
 * Build a client bound to the caller's JWT and resolve the user id. Throws a
 * Response-bearing error code string when unauthenticated (callers map it to
 * 401).
 *
 * SECURITY: SUPABASE_ANON_KEY is required — there is no service-role fallback.
 * If the anon key is missing the function throws immediately rather than
 * silently running under BYPASSRLS (which would expose every account's data to
 * every authenticated caller). Ensure SUPABASE_ANON_KEY is set in every
 * environment (production, staging, CI, local).
 */
export async function userContext(req: Request): Promise<UserContext> {
  const authHeader = req.headers.get('Authorization') ?? '';

  // Fail closed: requireEnv throws a clear error if SUPABASE_ANON_KEY is unset.
  // Do NOT add a service-role fallback here — BYPASSRLS would silently skip RLS.
  const anonKey = requireEnv('SUPABASE_ANON_KEY');

  const client = createClient(requireEnv('SUPABASE_URL'), anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) throw new UnauthorizedError('Missing bearer token.');

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new UnauthorizedError('Invalid or expired session.');

  return { client, userId: data.user.id };
}

export class UnauthorizedError extends Error {}
