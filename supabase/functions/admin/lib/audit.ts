// Server-side audit: every /admin/* call is logged (actor, action, target, and
// before/after for writes). Audit is a BE responsibility, not optional.

import { serviceClient } from './db.ts';
import type { AdminContext } from './auth.ts';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(ctx: AdminContext, entry: AuditEntry): Promise<void> {
  // Audit failures must not mask the operation's result; log and move on.
  try {
    await serviceClient()
      .from('admin_audit_log')
      .insert({
        actor: ctx.actorId,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
      });
  } catch (err) {
    console.error('audit write failed', entry.action, err);
  }
}
