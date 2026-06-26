// /admin/customers - account lookup, entitlement, retention, and deletion
// requests. Accounts live in the isolated identity store; tier and retention
// are derived from the customer's trips.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable, conflict } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';
import { sendEmail, syncContact } from '../../_shared/brevo.ts';
import { renderBrandedEmail } from '../../_shared/email-template.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Db = ReturnType<typeof serviceClient>;
type Status = 'active' | 'invited' | 'deletion-requested';

interface AccountRow {
  user_id: string;
  email: string;
  deletion_requested_at: string | null;
}

// The enriched, per-account facts the Users table wants: entitlement (best tier
// + latest retention from the trips), lifecycle status, account/sign-in times,
// and the traveller + trip counts.
interface Enrichment {
  tier: string | null;
  retentionExpiresAt: string | null;
  status: Status;
  createdAt: string | null;
  lastLoginAt: string | null;
  explorerCount: number;
  grownupCount: number;
  tripCount: number;
}

// Enrich a page of accounts. Trips and profiles are tallied with one query each;
// the auth timestamps (created/last sign-in) come from GoTrue per user, since
// auth.users isn't exposed to PostgREST. Returns a map keyed by user_id.
async function enrich(db: Db, accounts: AccountRow[]): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();
  const ids = accounts.map((a) => a.user_id);
  if (ids.length === 0) return out;

  const [authMetas, profilesRes, tripsRes] = await Promise.all([
    Promise.all(
      accounts.map(async (a) => {
        const { data } = await db.auth.admin.getUserById(a.user_id);
        return {
          id: a.user_id,
          createdAt: data?.user?.created_at ?? null,
          lastLoginAt: data?.user?.last_sign_in_at ?? null,
        };
      }),
    ),
    db.from('child_profiles').select('user_id, type').in('user_id', ids),
    db.from('trips').select('user_id, tier, retention_expires_at').in('user_id', ids),
  ]);

  const meta = new Map(authMetas.map((m) => [m.id, m]));
  const explorers = new Map<string, number>();
  const grownups = new Map<string, number>();
  for (const p of profilesRes.data ?? []) {
    const bucket = p.type === 'parent_carer' ? grownups : explorers;
    bucket.set(p.user_id as string, (bucket.get(p.user_id as string) ?? 0) + 1);
  }
  const tripCount = new Map<string, number>();
  const tier = new Map<string, string | null>();
  const retention = new Map<string, string | null>();
  for (const t of tripsRes.data ?? []) {
    const uid = t.user_id as string;
    tripCount.set(uid, (tripCount.get(uid) ?? 0) + 1);
    const cur = tier.get(uid) ?? null;
    if (t.tier === 'ours' || t.tier === 'byo') tier.set(uid, t.tier as string);
    else if (cur === null) tier.set(uid, (t.tier as string) ?? null);
    const r = t.retention_expires_at as string | null;
    const curR = retention.get(uid) ?? null;
    if (r && (!curR || r > curR)) retention.set(uid, r);
  }

  for (const a of accounts) {
    const m = meta.get(a.user_id);
    const lastLoginAt = m?.lastLoginAt ?? null;
    const status: Status = a.deletion_requested_at
      ? 'deletion-requested'
      : lastLoginAt
        ? 'active'
        : 'invited';
    out.set(a.user_id, {
      tier: tier.get(a.user_id) ?? null,
      retentionExpiresAt: retention.get(a.user_id) ?? null,
      status,
      createdAt: m?.createdAt ?? null,
      lastLoginAt,
      explorerCount: explorers.get(a.user_id) ?? 0,
      grownupCount: grownups.get(a.user_id) ?? 0,
      tripCount: tripCount.get(a.user_id) ?? 0,
    });
  }
  return out;
}

function toSummary(a: AccountRow, e: Enrichment) {
  return {
    userId: a.user_id,
    email: a.email,
    tier: e.tier,
    retentionExpiresAt: e.retentionExpiresAt,
    deletionRequested: a.deletion_requested_at != null,
    status: e.status,
    createdAt: e.createdAt,
    lastLoginAt: e.lastLoginAt,
    explorerCount: e.explorerCount,
    grownupCount: e.grownupCount,
    tripCount: e.tripCount,
  };
}

// Enrich + summarise a single account (the write handlers return one row).
async function summarize(db: Db, a: AccountRow) {
  const e = await enrich(db, [a]);
  return toSummary(a, e.get(a.user_id)!);
}

export async function searchCustomers(req: Request, _ctx: AdminContext): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const params = parsePageParams(url);

  let q = serviceClient()
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .order('email', { ascending: true });
  if (query) q = q.ilike('email', `%${query}%`);

  const { data, error } = await q.range(params.offset, rangeEnd(params));
  if (error) throw badRequest(error.message);
  const rows = data as AccountRow[];
  const enriched = await enrich(serviceClient(), rows);
  const items = rows.map((a) => toSummary(a, enriched.get(a.user_id)!));
  return ok(page(items, params));
}

export async function requestCustomerDeletion(
  _req: Request,
  ctx: AdminContext,
  id: string,
): Promise<Response> {
  const db = serviceClient();
  const { data, error } = await db
    .schema('identity')
    .from('accounts')
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq('user_id', id)
    .select('user_id, email, deletion_requested_at')
    .maybeSingle();
  if (error) throw badRequest(error.message);
  if (!data) throw notFound('Customer not found.');
  await writeAudit(ctx, {
    action: 'customer.deletion_request',
    targetType: 'account',
    targetId: id,
    after: { deletion_requested_at: data.deletion_requested_at },
  });
  return ok(await summarize(db, data as AccountRow));
}

// The invite email body. Magic-link sign-in finishes setup (2FA) on first use,
// so the CTA is the action_link minted by GoTrue.
function inviteEmail(name: string | undefined, actionLink: string): string {
  const hello = name ? `Hi ${name},` : 'Hi there,';
  return renderBrandedEmail({
    title: "You're invited to Yaycay",
    preheader: 'Your Yaycay account is ready - sign in to get started.',
    bodyHtml:
      `<p>${hello}</p>` +
      `<p>An account has been set up for you on Yaycay, your family-holiday companion. ` +
      `Tap the button below to sign in - we'll guide you through a quick, secure setup ` +
      `(a one-time code) the first time.</p>` +
      `<p style="font-size:14px;color:#6f695d;">This link is just for you; please don't share it.</p>`,
    cta: { label: 'Sign in to Yaycay', href: actionLink },
  });
}

/**
 * Invite / onboard a customer. Identity is invite-only (magic-link + mandatory
 * 2FA, no admin-set passwords), so this provisions a pending account, emails a
 * sign-in link, and records the lead - the person finishes setup on first
 * sign-in. Idempotent on email: an existing account is returned (200) with the
 * link resent, never a 409 or a duplicate.
 */
export async function inviteCustomer(req: Request, ctx: AdminContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  if (!EMAIL_RE.test(email)) throw unprocessable('A valid email is required.');

  const db = serviceClient();

  // Was this email already a customer? Drives create (201) vs resend (200).
  const { data: before, error: beforeErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id')
    .ilike('email', email)
    .maybeSingle();
  if (beforeErr) throw badRequest(beforeErr.message);
  const existed = before != null;

  // Provision (or resolve) the auth user and mint a one-time magic link.
  // generateLink('magiclink') creates the user when absent - the identity
  // trigger mirrors it into identity.accounts - and returns the sign-in link.
  const link = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data?.user) {
    throw badRequest(link.error?.message ?? 'Could not provision the account.');
  }
  const userId = link.data.user.id;
  const actionLink = (link.data.properties?.action_link as string | undefined) ?? null;

  // Record the lead like a normal signup, but only on first touch - an admin
  // invite carries no marketing opt-in, and we must not clobber a prior consent
  // choice on re-invite, so leave an existing contact untouched.
  const { data: contact } = await db
    .from('marketing_contacts')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (!contact) {
    const synced = await syncContact({
      email,
      name,
      consent: false,
      attributes: { SOURCE: 'admin_invite' },
    });
    await db.from('marketing_contacts').insert({
      email,
      name: name ?? null,
      source: 'admin_invite',
      consent: false,
      attributes: {},
      brevo_synced_at: synced ? new Date().toISOString() : null,
    });
  }

  // Email the magic-link invite (transactional; no marketing consent needed).
  // Soft-fail if no sender is configured (local/CI) - the account still exists
  // and the admin can resend - but surface a hard Brevo error so it's visible.
  if (actionLink) {
    try {
      await sendEmail({
        to: email,
        subject: "You're invited to Yaycay",
        html: inviteEmail(name, actionLink),
      });
    } catch (err) {
      console.error('invite email send failed', err);
    }
  }

  // Build the summary from the now-existing identity row (fresh => tier null,
  // no retention, not deletion-requested).
  const { data: account, error: accErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .eq('user_id', userId)
    .single();
  if (accErr) throw badRequest(accErr.message);

  await writeAudit(ctx, {
    action: 'customer.invite',
    targetType: 'account',
    targetId: userId,
    after: { email, resent: existed },
  });

  return ok(await summarize(db, account as AccountRow), existed ? 200 : 201);
}

/**
 * Change a customer's sign-in email (PATCH /admin/customers/{id}/email). Updates
 * the auth user (keeping magic-link + 2FA intact) and the isolated identity row.
 * Trips stay owned by user_id, so nothing to re-point. Marketing contact email
 * is best-effort kept in sync.
 */
export async function changeEmail(
  req: Request,
  ctx: AdminContext,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) throw unprocessable('A valid email is required.');

  const db = serviceClient();
  const { data: acct, error: selErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email, deletion_requested_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!acct) throw notFound('Customer not found.');
  const before = (acct as AccountRow).email;

  // Update the auth identity first (source of truth for sign-in). email_confirm
  // keeps the account usable immediately without a re-confirmation round-trip.
  const upd = await db.auth.admin.updateUserById(userId, { email, email_confirm: true });
  if (upd.error) {
    const msg = upd.error.message ?? 'Could not update the email.';
    if (/already|registered|exists|duplicate/i.test(msg)) {
      throw conflict('That email is already in use by another account.');
    }
    throw badRequest(msg);
  }

  // Mirror into the identity store (no trigger syncs email updates) and Brevo.
  const { error: idErr } = await db
    .schema('identity')
    .from('accounts')
    .update({ email })
    .eq('user_id', userId);
  if (idErr) throw badRequest(idErr.message);
  await db.from('marketing_contacts').update({ email }).eq('email', before);

  await writeAudit(ctx, {
    action: 'customer.email_change',
    targetType: 'account',
    targetId: userId,
    before: { email: before },
    after: { email },
  });

  return ok(await summarize(db, { user_id: userId, email, deletion_requested_at: acct.deletion_requested_at }));
}

/**
 * Remove a never-activated invite (DELETE /admin/customers/{id}). Only for
 * accounts that were invited but never signed in and own no data - an activated
 * or data-owning account must go through the deletion-request + execute flow,
 * which confirms and audits the destructive purge.
 */
export async function removeInvite(
  _req: Request,
  ctx: AdminContext,
  userId: string,
): Promise<Response> {
  const db = serviceClient();
  const { data: acct, error: selErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email')
    .eq('user_id', userId)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!acct) throw notFound('Customer not found.');

  // Guard: never-signed-in only.
  const { data: authData } = await db.auth.admin.getUserById(userId);
  if (authData?.user?.last_sign_in_at) {
    throw conflict('This account has been activated; use the deletion-request flow instead.');
  }
  // Guard: owns no trips (an invite shouldn't, but never purge data silently).
  const { count } = await db
    .from('trips')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if ((count ?? 0) > 0) {
    throw conflict('This account owns trips; use the deletion-request flow instead.');
  }

  const { error: delErr } = await db.auth.admin.deleteUser(userId);
  if (delErr) throw badRequest(delErr.message);

  await writeAudit(ctx, {
    action: 'customer.invite_remove',
    targetType: 'account',
    targetId: userId,
    before: { email: (acct as { email: string }).email },
  });
  return ok({ removed: true });
}
