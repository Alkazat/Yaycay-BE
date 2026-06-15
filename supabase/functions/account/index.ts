// /account - the signed-in owner's own account (read + light update).
//
// The account is the parent/owner row in the isolated `identity` store, keyed to
// the auth user. It is distinct from /profiles (the per-child rows). We verify
// the caller's JWT (user-scoped), resolve their user id, then read/write the
// single accounts row for that user through the service role, since the identity
// schema is revoked from the authenticated client. Email and tier are
// server-owned; the only consumer-mutable field is the secondary (recovery)
// email. `tier` is the account's best entitlement, derived from purchases.
//
// Routes (this function owns all /account/* paths):
//   GET    /account                    read the account
//   PATCH  /account                    update name / secondary email
//   GET    /account/transactions       purchase history (newest first)
//   POST   /account/deletion-request   request data deletion (stamps a time)
//   DELETE /account/deletion-request   cancel a pending deletion request

import { error, handlePreflight, json } from '../_shared/http.ts';
import { userContext, UnauthorizedError } from '../_shared/user-client.ts';
import { serviceClient } from '../_shared/service-client.ts';

const ACCOUNT_COLUMNS =
  'email, name, recovery_email, role, two_factor_enrolled, deletion_requested_at, retention_expires_at, created_at';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 120;

type Tier = 'free' | 'byo' | 'ours';
const TIER_RANK: Record<string, number> = { free: 0, byo: 1, ours: 2 };
const TIER_LABEL: Record<string, string> = {
  ours: 'Holiday (our AI)',
  byo: 'Holiday (bring your own AI)',
  free: 'Free',
};

// The part of the path after `/account`, trimmed of slashes ('' for the root).
function subPath(url: URL): string {
  const marker = '/account';
  const i = url.pathname.indexOf(marker);
  const rest = i === -1 ? '' : url.pathname.slice(i + marker.length);
  return rest.replace(/^\/+|\/+$/g, '');
}

interface AccountRow {
  email: string;
  name: string | null;
  recovery_email: string | null;
  role: string;
  two_factor_enrolled: boolean;
  deletion_requested_at: string | null;
  retention_expires_at: string | null;
  created_at: string;
}

function toAccount(r: AccountRow, tier: Tier) {
  return {
    email: r.email,
    name: r.name ?? null,
    secondary_email: r.recovery_email ?? null,
    tier,
    role: r.role,
    two_factor_enrolled: r.two_factor_enrolled,
    deletion_requested_at: r.deletion_requested_at ?? null,
    // Account-level keep ("keep my memories"): all the customer's data is
    // retained until this date; null = default per-trip disposal applies.
    data_kept_until: r.retention_expires_at ?? null,
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

type Svc = ReturnType<typeof serviceClient>;

// Read the account row, returning a 404 Response when it is missing.
async function loadAccount(svc: Svc, userId: string): Promise<AccountRow | Response> {
  const { data, error: dbErr } = await svc
    .schema('identity')
    .from('accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  if (!data) return error('not_found', 'Account not found.', 404);
  return data as AccountRow;
}

async function respondWithAccount(svc: Svc, userId: string, row: AccountRow): Promise<Response> {
  const tier = await deriveTier(svc, userId);
  return json(toAccount(row, tier), 200);
}

async function handleGet(svc: Svc, userId: string): Promise<Response> {
  const row = await loadAccount(svc, userId);
  if (row instanceof Response) return row;
  return respondWithAccount(svc, userId, row);
}

async function handlePatch(svc: Svc, userId: string, req: Request): Promise<Response> {
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
  if (body.name !== undefined) {
    const v = body.name;
    if (v === null || (typeof v === 'string' && v.trim() === '')) {
      patch.name = null;
    } else if (typeof v === 'string' && v.trim().length <= NAME_MAX) {
      patch.name = v.trim();
    } else {
      return error(
        'validation_error',
        `name must be a string up to ${NAME_MAX} chars, or null.`,
        422,
        ['name'],
      );
    }
  }

  if (Object.keys(patch).length === 0) {
    return error('validation_error', 'No updatable fields supplied.', 422, [
      'name',
      'secondary_email',
    ]);
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
  return respondWithAccount(svc, userId, data as AccountRow);
}

// POST stamps deletion_requested_at (preserving the earliest request); DELETE
// clears it. Both return the account so the FE can reflect the new state.
async function handleDeletionRequest(svc: Svc, userId: string, cancel: boolean): Promise<Response> {
  const existing = await loadAccount(svc, userId);
  if (existing instanceof Response) return existing;

  let value: string | null;
  if (cancel) {
    value = null;
  } else {
    // Idempotent: keep the original request time if one is already set.
    value = existing.deletion_requested_at ?? new Date().toISOString();
  }

  const { data, error: dbErr } = await svc
    .schema('identity')
    .from('accounts')
    .update({ deletion_requested_at: value })
    .eq('user_id', userId)
    .select(ACCOUNT_COLUMNS)
    .maybeSingle();
  if (dbErr) throw new Error(dbErr.message);
  if (!data) return error('not_found', 'Account not found.', 404);
  return respondWithAccount(svc, userId, data as AccountRow);
}

// Purchase history for the Settings "Transaction history" list. Sourced from the
// purchases table (set by the Stripe webhook); description from the catalogue
// product name, falling back to a tier label. All recorded purchases are
// completed checkouts, so status is 'paid' (refunds/pending are not tracked yet).
async function handleTransactions(svc: Svc, userId: string): Promise<Response> {
  const { data, error: dbErr } = await svc
    .from('purchases')
    .select('id, created_at, amount_usd, tier, price_id, products(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (dbErr) throw new Error(dbErr.message);
  const transactions = (data ?? []).map((p) => {
    const prod = Array.isArray(p.products) ? p.products[0] : p.products;
    const description =
      (prod as { name?: string } | null)?.name ?? TIER_LABEL[p.tier as string] ?? 'Purchase';
    return {
      id: p.id as string,
      date: p.created_at as string,
      description,
      amount_usd: p.amount_usd != null ? Number(p.amount_usd) : 0,
      status: 'paid' as const,
    };
  });
  return json({ transactions });
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const { userId } = await userContext(req);
    const svc = serviceClient();
    const sub = subPath(new URL(req.url));

    if (sub === '') {
      if (req.method === 'GET') return await handleGet(svc, userId);
      if (req.method === 'PATCH') return await handlePatch(svc, userId, req);
      return error('method_not_allowed', 'Use GET or PATCH.', 405);
    }

    if (sub === 'transactions') {
      if (req.method === 'GET') return await handleTransactions(svc, userId);
      return error('method_not_allowed', 'Use GET.', 405);
    }

    if (sub === 'deletion-request') {
      if (req.method === 'POST') return await handleDeletionRequest(svc, userId, false);
      if (req.method === 'DELETE') return await handleDeletionRequest(svc, userId, true);
      return error('method_not_allowed', 'Use POST or DELETE.', 405);
    }

    return error('not_found', 'Unknown account route.', 404);
  } catch (err) {
    if (err instanceof UnauthorizedError) return error('unauthorized', err.message, 401);
    console.error('account error', err);
    return error('internal_error', 'Could not process the account request.', 500);
  }
});
