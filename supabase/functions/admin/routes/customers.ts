// /admin/customers - account lookup, entitlement, retention, and deletion
// requests. Accounts live in the isolated identity store; tier and retention
// are derived from the customer's trips.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import { parsePageParams, page, rangeEnd } from '../lib/pagination.ts';
import type { AdminContext } from '../lib/auth.ts';
import { sendEmail, syncContact } from '../../_shared/brevo.ts';
import { renderBrandedEmail } from '../../_shared/email-template.ts';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface AccountRow {
  user_id: string;
  email: string;
  deletion_requested_at: string | null;
}

// Derive the best-known tier and the latest retention date from the user's
// trips. A paid tier (ours/byo) wins over free.
async function entitlement(
  userId: string,
): Promise<{ tier: string | null; retentionExpiresAt: string | null }> {
  const { data } = await serviceClient()
    .from('trips')
    .select('tier, retention_expires_at')
    .eq('user_id', userId);
  let tier: string | null = null;
  let retention: string | null = null;
  for (const t of data ?? []) {
    if (t.tier === 'ours' || t.tier === 'byo') tier = t.tier;
    else if (tier === null) tier = t.tier;
    if (t.retention_expires_at && (!retention || t.retention_expires_at > retention)) {
      retention = t.retention_expires_at;
    }
  }
  return { tier, retentionExpiresAt: retention };
}

async function toSummary(a: AccountRow) {
  const ent = await entitlement(a.user_id);
  return {
    userId: a.user_id,
    email: a.email,
    tier: ent.tier,
    retentionExpiresAt: ent.retentionExpiresAt,
    deletionRequested: a.deletion_requested_at != null,
  };
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
  const items = await Promise.all((data as AccountRow[]).map(toSummary));
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
  return ok(await toSummary(data as AccountRow));
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

  return ok(await toSummary(account as AccountRow), existed ? 200 : 201);
}
