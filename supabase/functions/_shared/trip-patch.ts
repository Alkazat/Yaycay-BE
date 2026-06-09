// TripContentPatch: the structured edit the AI harness emits.
//
// The harness never rewrites the whole payload; `generate`/`ingest` produce a
// patch (a small list of ops), which is applied to the current `trip_content`,
// then re-validated against the schema before persisting. The op vocabulary is
// the same one the BYO-AI MCP tools will expose (add_activity, move_activity,
// ...), so a single apply path serves both our-AI and BYO-AI writes.

import type { Activity, Booking, Day, Moment, TripContent } from './content-types.ts';

export type PatchOp =
  | { op: 'add_day'; day: Day }
  | { op: 'set_day_summary'; day_id: string; summary: string }
  | { op: 'add_moment'; day_id: string; moment: Moment }
  | { op: 'add_activity'; day_id: string; moment_id: string; activity: Activity }
  | { op: 'update_activity'; activity_id: string; set: Partial<Omit<Activity, 'id'>> }
  | { op: 'move_activity'; activity_id: string; to_moment_id: string }
  | { op: 'set_booking'; activity_id: string; booking: Booking };

export interface TripContentPatch {
  ops: PatchOp[];
  /** Short human-readable note on what changed (shown to the parent). */
  note?: string;
}

/** Thrown when a patch references an id that is not in the content. */
export class PatchError extends Error {}

// A unique-ish id for harness-created nodes when the model omits one.
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

// Fill any missing ids on a moment (and its activities) so added subtrees are
// always addressable.
function normaliseMoment(moment: Moment): Moment {
  const m = { ...moment, id: moment.id || newId('m') };
  m.activities = (Array.isArray(m.activities) ? m.activities : []).map((a) => ({
    ...a,
    id: a.id || newId('a'),
  }));
  return m;
}

function normaliseDay(day: Day): Day {
  const d = { ...day, id: day.id || newId('d') };
  d.moments = (Array.isArray(d.moments) ? d.moments : []).map(normaliseMoment);
  return d;
}

function findDay(content: TripContent, dayId: string): Day {
  const day = content.days.find((d) => d.id === dayId);
  if (!day) throw new PatchError(`No day with id ${dayId}`);
  return day;
}

function findMoment(content: TripContent, momentId: string): Moment {
  for (const day of content.days) {
    const moment = day.moments.find((m) => m.id === momentId);
    if (moment) return moment;
  }
  throw new PatchError(`No moment with id ${momentId}`);
}

function findActivityHost(
  content: TripContent,
  activityId: string,
): { moment: Moment; index: number } {
  for (const day of content.days) {
    for (const moment of day.moments) {
      const index = moment.activities.findIndex((a) => a.id === activityId);
      if (index !== -1) return { moment, index };
    }
  }
  throw new PatchError(`No activity with id ${activityId}`);
}

/**
 * Apply a patch to a copy of the content and return the new content. Pure: the
 * input is never mutated. Throws {@link PatchError} when an op targets a
 * missing node, so the caller can reject the whole patch (422) atomically.
 */
export function applyPatch(content: TripContent, patch: TripContentPatch): TripContent {
  const next: TripContent = structuredClone(content);
  if (!Array.isArray(next.days)) next.days = [];

  for (const op of patch.ops) {
    switch (op.op) {
      case 'add_day': {
        next.days.push(normaliseDay(op.day));
        break;
      }
      case 'set_day_summary': {
        findDay(next, op.day_id).summary = op.summary;
        break;
      }
      case 'add_moment': {
        findDay(next, op.day_id).moments.push(normaliseMoment(op.moment));
        break;
      }
      case 'add_activity': {
        const day = findDay(next, op.day_id);
        const moment = day.moments.find((m) => m.id === op.moment_id);
        if (!moment) throw new PatchError(`No moment ${op.moment_id} in day ${op.day_id}`);
        moment.activities.push({ ...op.activity, id: op.activity.id || newId('a') });
        break;
      }
      case 'update_activity': {
        const { moment, index } = findActivityHost(next, op.activity_id);
        // id is immutable; never let `set` overwrite it.
        moment.activities[index] = { ...moment.activities[index], ...op.set, id: op.activity_id };
        break;
      }
      case 'move_activity': {
        const { moment, index } = findActivityHost(next, op.activity_id);
        const target = findMoment(next, op.to_moment_id);
        const [activity] = moment.activities.splice(index, 1);
        target.activities.push(activity);
        break;
      }
      case 'set_booking': {
        const { moment, index } = findActivityHost(next, op.activity_id);
        moment.activities[index] = { ...moment.activities[index], booking: op.booking };
        break;
      }
      default: {
        // Exhaustiveness guard: a new op type must be handled above.
        const _never: never = op;
        throw new PatchError(`Unknown op: ${JSON.stringify(_never)}`);
      }
    }
  }

  return next;
}

const OP_NAMES = new Set([
  'add_day',
  'set_day_summary',
  'add_moment',
  'add_activity',
  'update_activity',
  'move_activity',
  'set_booking',
]);

/**
 * Shallow structural check that a value is a well-formed patch (the op names are
 * known and required keys are present). Deep validation of the resulting content
 * is the schema validator's job, after {@link applyPatch}.
 */
export function validatePatchShape(input: unknown): string[] {
  const errors: string[] = [];
  const root = input as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return ['patch must be an object'];
  if (!Array.isArray(root.ops)) return ['patch.ops must be an array'];
  if (root.ops.length === 0) errors.push('patch.ops must not be empty');

  root.ops.forEach((raw, i) => {
    const o = raw as Record<string, unknown>;
    const at = `ops[${i}]`;
    if (!o || typeof o !== 'object' || typeof o.op !== 'string' || !OP_NAMES.has(o.op)) {
      errors.push(`${at}.op must be one of ${[...OP_NAMES].join('|')}`);
      return;
    }
    const need = (field: string) => {
      if (typeof o[field] !== 'string' || (o[field] as string).length === 0) {
        errors.push(`${at}.${field} is required for ${o.op}`);
      }
    };
    const needObj = (field: string) => {
      if (!o[field] || typeof o[field] !== 'object') {
        errors.push(`${at}.${field} is required for ${o.op}`);
      }
    };
    switch (o.op) {
      case 'add_day':
        needObj('day');
        break;
      case 'set_day_summary':
        need('day_id');
        need('summary');
        break;
      case 'add_moment':
        need('day_id');
        needObj('moment');
        break;
      case 'add_activity':
        need('day_id');
        need('moment_id');
        needObj('activity');
        break;
      case 'update_activity':
        need('activity_id');
        needObj('set');
        break;
      case 'move_activity':
        need('activity_id');
        need('to_moment_id');
        break;
      case 'set_booking':
        need('activity_id');
        needObj('booking');
        break;
    }
  });

  return errors;
}
