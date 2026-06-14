// Unified auth for the BYO-AI MCP endpoint.
//
// `verifyMcpToken` accepts EITHER of the two BYO-AI auth models and resolves both
// to one shape, per docs/handoff/MCP-CONNECTOR-BE-RESPONSE.md item 3:
//
//   - a BE-issued connector token (HMAC, per-trip; see ./mcp-token.ts). Carries
//     a single trip, so `trip` is set.
//   - an OAuth grant access token (account-scoped, issued by the AS). Opaque, so
//     it is validated by SHA-256 hash lookup against `oauth_grants`; account-wide,
//     so `trip` is absent and the caller must name the trip per request.
//
// OAuth is the primary path; the connector token stays as the power-user per-trip
// alternative. Both are gated by scope. Tokens are never stored in the clear: the
// connector token is verified by signature, the OAuth token by hash.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { TokenError, verifyToken } from './mcp-token.ts';

export type McpAuthKind = 'connector' | 'oauth';

export interface McpAuth {
  /** Owning user id (acts-as for every tool call). */
  user: string;
  /** Granted scopes. */
  scopes: string[];
  /** The single trip a connector token is bound to; absent for account-scoped grants. */
  trip?: string;
  kind: McpAuthKind;
  /** connectors.id (connector kind) */
  connectorId?: string;
  /** oauth_grants.id (oauth kind) */
  grantId?: string;
}

export class McpAuthError extends Error {}

/**
 * SHA-256 hex of a token. The AS stores only the hash of the access tokens it
 * issues, so we validate by hashing the presented token and looking it up - the
 * token itself is never persisted in the clear.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Resolve a bearer token to `{ user, scopes, trip? }`, dual-accepting a connector
 * token or an OAuth grant access token, and stamping `last_used_at` on whichever
 * row backs it. Throws `McpAuthError` when the token is unknown, revoked, or
 * expired. Requires a service-role client (`oauth_grants` is service-role only).
 */
export async function verifyMcpToken(token: string, db: SupabaseClient): Promise<McpAuth> {
  // 1) Connector token (self-verifying HMAC). verifyToken throws TokenError when
  //    the token is not a well-formed, correctly-signed connector token; in that
  //    case we fall through to the OAuth grant path.
  try {
    const claims = await verifyToken(token);
    const { data: connector } = await db
      .from('connectors')
      .select('id, user_id, trip_id, scopes, revoked_at')
      .eq('id', claims.cid)
      .maybeSingle();
    if (!connector || connector.revoked_at || connector.trip_id !== claims.tid) {
      throw new McpAuthError('Connector is not active.');
    }
    await db
      .from('connectors')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', claims.cid);
    return {
      user: claims.uid,
      scopes: (connector.scopes as string[] | null) ?? claims.scope ?? [],
      trip: claims.tid,
      kind: 'connector',
      connectorId: connector.id as string,
    };
  } catch (err) {
    if (err instanceof McpAuthError) throw err;
    if (!(err instanceof TokenError)) throw err;
    // Not a connector token - fall through to the OAuth grant path.
  }

  // 2) OAuth grant access token (opaque; validated by hash against oauth_grants).
  const hash = await sha256Hex(token);
  const { data: grant } = await db
    .from('oauth_grants')
    .select('id, user_id, scope, access_token_expires_at, revoked_at')
    .eq('access_token_hash', hash)
    .maybeSingle();
  if (!grant) throw new McpAuthError('Unknown or invalid token.');
  if (grant.revoked_at) throw new McpAuthError('Grant has been revoked.');
  if (
    grant.access_token_expires_at &&
    new Date(grant.access_token_expires_at as string).getTime() <= Date.now()
  ) {
    throw new McpAuthError('Grant access token has expired.');
  }
  await db
    .from('oauth_grants')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', grant.id);
  return {
    user: grant.user_id as string,
    scopes: String(grant.scope ?? '')
      .split(/\s+/)
      .filter(Boolean),
    trip: undefined,
    kind: 'oauth',
    grantId: grant.id as string,
  };
}
