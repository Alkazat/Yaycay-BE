// /account - the signed-in owner's own account (read + light update).
//
// The account is the parent/owner row in the isolated `identity` store, keyed to
// the auth user. It is distinct from /profiles (the per-child rows). We verify
// the caller's JWT (user-scoped), resolve their user id, then read/write the
// single accounts row for that user through the service role, since the identity
// schema is revoked from the authenticated client. Email and tier are
// server-owned; the only consumer-mutable field is the secondary (recovery)
// email. `tier` is the account's best entitlement, derived from purchases.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';

const ACCOUNT_COLUMNS =
  'email, recovery_email, role, two_factor_enrolled, deletion_requested_at, created_at';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Tier = 'free' | 'byo' | 'ours';
const TIER_RANK: Record<string, number> = { free: 0, byo: 1, ours: 2 };

interface AccountRow {
  email: string;
  recovery_email: string | null;
  role: string;
  two_factor_enrolled: boolean;
  deletion_requested_at: string | null;
  created_at: string;
}

function toAccount(r: AccountRow, tier: Tier) {
  return {
    email: r.email,
    secondary_email: r.recovery_email ?? null,
    tier,
    role: r.role,
    two_factor_enrolled: r.two_factor_enrolled,
    deletion_requested_at: r.deletion_requested_at ?? null,
    created_at: r.created_at,
  };
}

// The account's tier is its best (highest) purchased entitlement, defaulting to
// free when the user has never bought a paid tier.
async function deriveTier(svc: ReturnType<typeof serviceClient>, userId: string): Promise<Tier> {
  const { data } = await svc.from('purchases').select('tier').eq('user_id', userId);
  let best: Tier = 'free';
  for (const row of data ?? []) {
    const t = row.tier as string | null;
    if (t && (TIER_RANK[t] ?? -1) > TIER_RANK[best]) best = t as Tier;
  }
  return best;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const { userId } = await userContext(req);
    const svc = serviceClient();

    if (req.method === 'GET') {
      const { data, error: dbErr } = await svc
        .schema('identity')
        .from('accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('user_id', userId)
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) return error('not_found', 'Account not found.', 404);
      const tier = await deriveTier(svc, userId);
      return json(toAccount(data as AccountRow, tier), 200);
    }

    if (req.method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return error('validation_error', 'Request body must be JSON.', 422);
      }

      const patch: Record<string, unknown> = {};
      if (body.secondary_email !== undefined) {
        const v = body.secondary_email;
        if (v === null || v === '') {
          patch.recovery_email = null;
        } else if (typeof v === 'string' && EMAIL_RE.test(v.trim())) {
          patch.recovery_email = v.trim().toLowerCase();
        } else {
          return error('validation_error', 'secondary_email must be a valid email or null.', 422, [
            'secondary_email',
          ]);
        }
      }

      if (Object.keys(patch).length === 0) {
        return error('validation_error', 'No updatable fields supplied.', 422, ['secondary_email']);
      }

      const { data, error: dbErr } = await svc
        .schema('identity')
        .from('accounts')
        .update(patch)
        .eq('user_id', userId)
        .select(ACCOUNT_COLUMNS)
        .maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) return error('not_found', 'Account not found.', 404);
      const tier = await deriveTier(svc, userId);
      return json(toAccount(data as AccountRow, tier), 200);
    }

    return error('method_not_allowed', 'Use GET or PATCH.', 405);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('account error', err);
    return error('internal_error', 'Could not process the account request.', 500);
  }
});
