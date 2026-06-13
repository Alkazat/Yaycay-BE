// /admin/admins - list admin accounts and set an account's role. Role lives in
// the isolated identity store. Every call is already admin+AAL2 gated by
// requireAdmin; role changes are audited.

import { serviceClient } from '../lib/db.ts';
import { ok, badRequest, notFound, unprocessable } from '../lib/http.ts';
import { writeAudit } from '../lib/audit.ts';
import type { AdminContext } from '../lib/auth.ts';

const ROLES = ['user', 'admin'];

interface AccountRow {
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}

function toAdminAccount(r: AccountRow) {
  return { userId: r.user_id, email: r.email, role: r.role, createdAt: r.created_at };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw badRequest('Request body must be JSON.');
  }
}

export async function listAdmins(_req: Request, _ctx: AdminContext): Promise<Response> {
  const { data, error } = await serviceClient()
    .schema('identity')
    .from('accounts')
    .select('user_id, email, role, created_at')
    .eq('role', 'admin')
    .order('created_at', { ascending: true });
  if (error) throw badRequest(error.message);
  return ok({ items: (data as AccountRow[]).map(toAdminAccount) });
}

// Set an account's role by email (promote to admin, or demote to user). The
// account must already exist - it is provisioned on the person's first sign-in,
// so an unknown email is a 404 (no pending-invite flow).
export async function setAdminRole(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readJson(req);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const role = typeof body.role === 'string' ? body.role : 'admin';
  if (!email) throw unprocessable('email is required');
  if (!ROLES.includes(role)) throw unprocessable('role must be user or admin');

  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .schema('identity')
    .from('accounts')
    .select('user_id, email, role, created_at')
    .ilike('email', email)
    .maybeSingle();
  if (selErr) throw badRequest(selErr.message);
  if (!existing) {
    throw notFound(
      'No account for that email yet. The person must sign in once (which provisions their account) before they can be promoted.',
    );
  }

  const before = existing as AccountRow;
  const { data, error } = await db
    .schema('identity')
    .from('accounts')
    .update({ role })
    .eq('user_id', before.user_id)
    .select('user_id, email, role, created_at')
    .single();
  if (error) throw badRequest(error.message);

  await writeAudit(ctx, {
    action: 'admin.role.set',
    targetType: 'account',
    targetId: before.user_id,
    before: { role: before.role },
    after: { role },
  });
  return ok(toAdminAccount(data as AccountRow));
}
