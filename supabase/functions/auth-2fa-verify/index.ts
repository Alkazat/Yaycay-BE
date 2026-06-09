// POST /auth/2fa/verify - verify the one-time 2FA code on sign-in.
//
// Wraps Supabase's native MFA: it challenges the caller's enrolled TOTP factor
// and verifies the supplied code. On success the session is elevated to AAL2,
// which is what the admin surface requires. Full MFA enrolment (adding the
// factor) is part of the broader Phase 1 auth work.

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);

  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return error('invalid_json', 'Request body must be JSON.', 422);
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (code.length < 4) {
      return error('validation_error', 'A valid code is required.', 422, ['code is required']);
    }

    const { client } = await userContext(req);

    const { data: factors, error: listErr } = await client.auth.mfa.listFactors();
    if (listErr) return error('mfa_error', listErr.message, 422);
    const factor = (factors?.totp ?? []).find((f) => f.status === 'verified') ?? factors?.totp?.[0];
    if (!factor) {
      return error('no_factor', 'No MFA factor is enrolled for this account.', 422);
    }

    const { data: challenge, error: chErr } = await client.auth.mfa.challenge({
      factorId: factor.id,
    });
    if (chErr || !challenge) return error('mfa_error', chErr?.message ?? 'Challenge failed.', 422);

    const { error: verifyErr } = await client.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.id,
      code,
    });
    if (verifyErr) {
      // Wrong or expired code.
      return error('invalid_code', 'The code is incorrect or has expired.', 401);
    }

    return json({ verified: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('2fa verify error', err);
    return error('internal_error', 'Unexpected error.', 500);
  }
});
