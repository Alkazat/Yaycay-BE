// /account - the signed-in owner's own account (read + light update).
//
// The account is the parent/owner row in the isolated `identity` store, keyed to
// the auth user. It is distinct from /profiles (the per-child rows). We verify
// the caller's JWT (user-scoped), resolve their user id, then read/write the
// single accounts row for that user through the service role, since the identity
// schema is revoked from the authenticated client. Email and role are
// server-owned; the only consumer-mutable field is the recovery email.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';

const ACCOUNT_COLUMNS =
  'email, recovery_email, role, two_factor_enrolled, deletion_requested_at, created_at';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AccountRow {
  email: string;
  recovery_email: string | null;
  role: string;
  two_factor_enrolled: boolean;
  deletion_requested_at: string | null;
  created_at: string;
}

function toAccount(r: AccountRow) {
  return {
    email: r.email,
    recoveryEmail: r.recovery_email ?? null,
    role: r.role,
    twoFactorEnrolled: r.two_factor_enrolled,
    deletionRequestedAt: r.deletion_requested_at ?? null,
    createdAt: r.created_at,
  };
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
      return json(toAccount(data as AccountRow), 200);
    }

    if (req.method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return error('validation_error', 'Request body must be JSON.', 422);
      }

      const patch: Record<string, unknown> = {};
      if (body.recoveryEmail !== undefined) {
        const v = body.recoveryEmail;
        if (v === null || v === '') {
          patch.recovery_email = null;
        } else if (typeof v === 'string' && EMAIL_RE.test(v.trim())) {
          patch.recovery_email = v.trim().toLowerCase();
        } else {
          return error('validation_error', 'recoveryEmail must be a valid email or null.', 422, [
            'recoveryEmail',
          ]);
        }
      }

      if (Object.keys(patch).length === 0) {
        return error('validation_error', 'No updatable fields supplied.', 422, ['recoveryEmail']);
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
      return json(toAccount(data as AccountRow), 200);
    }

    return error('method_not_allowed', 'Use GET or PATCH.', 405);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('account error', err);
    return error('internal_error', 'Could not process the account request.', 500);
  }
});
