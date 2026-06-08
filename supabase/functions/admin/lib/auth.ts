// Admin authentication: require a Supabase JWT with role=admin (from the
// isolated identity store) AND AAL2 (verified MFA). The gateway has already
// verified the JWT signature (verify_jwt = true); here we read the claims and
// check entitlement.

import { forbidden, ProblemError } from './http.ts';
import { serviceClient } from './db.ts';

export interface AdminContext {
  /** The authenticated user id (JWT sub). */
  actorId: string;
  email: string | null;
}

interface JwtClaims {
  sub?: string;
  email?: string;
  aal?: string;
}

function decodeClaims(token: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw forbidden('Malformed bearer token.');
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    return JSON.parse(json) as JwtClaims;
  } catch {
    throw forbidden('Could not read token claims.');
  }
}

/**
 * Enforce admin access. Throws a 403 ProblemError when the caller is missing a
 * token, is not AAL2, or is not an admin in the identity store.
 */
export async function requireAdmin(req: Request): Promise<AdminContext> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw forbidden('Missing bearer token.');

  const claims = decodeClaims(token);
  if (!claims.sub) throw forbidden('Token has no subject.');

  // MFA: the assurance level must be aal2.
  if (claims.aal !== 'aal2') {
    throw forbidden('Multi-factor authentication (AAL2) is required for admin access.');
  }

  // Role lives in the isolated identity store.
  const { data, error } = await serviceClient()
    .schema('identity')
    .from('accounts')
    .select('role, email')
    .eq('user_id', claims.sub)
    .maybeSingle();

  if (error) throw new ProblemError(500, 'Internal Server Error', 'Could not verify admin role.');
  if (!data || data.role !== 'admin') throw forbidden('Admin role required.');

  return { actorId: claims.sub, email: data.email ?? claims.email ?? null };
}
