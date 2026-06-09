// Deno tests for the pure patch layer. No network or Supabase needed; uses
// minimal local assertions so it runs without external (JSR) dependencies.
import { applyPatch, PatchError, validatePatchShape } from './trip-patch.ts';
import type { TripContent } from './content-types.ts';

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => unknown, ctor: new (...a: never[]) => Error): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ctor) return;
    throw new Error(`Threw ${err}, expected ${ctor.name}`);
  }
  throw new Error(`Expected a ${ctor.name} to be thrown`);
}

function baseContent(): TripContent {
  return {
    trip: {
      id: 't1',
      destination: 'Lisbon',
      start_date: '2026-07-01',
      end_date: '2026-07-05',
    },
    days: [
      {
        id: 'd1',
        moments: [
          {
            id: 'm1',
            slot: 'morning',
            title: 'Explore',
            activities: [{ id: 'a1', kind: 'kid', title: 'Walk' }],
          },
        ],
      },
    ],
  };
}

Deno.test('add_activity appends to the named moment without mutating input', () => {
  const content = baseContent();
  const next = applyPatch(content, {
    ops: [
      {
        op: 'add_activity',
        day_id: 'd1',
        moment_id: 'm1',
        activity: { id: 'a2', kind: 'shared', title: 'Lunch' },
      },
    ],
  });
  assertEquals(next.days[0].moments[0].activities.length, 2);
  assertEquals(content.days[0].moments[0].activities.length, 1, 'input is not mutated');
});

Deno.test('add_day/add_moment generate ids when omitted', () => {
  const next = applyPatch(baseContent(), {
    ops: [
      {
        op: 'add_day',
        day: { id: '', moments: [{ id: '', slot: 'anytime', title: 'New', activities: [] }] },
      },
    ],
  });
  assertEquals(next.days.length, 2);
  const added = next.days[1];
  assertEquals(added.id.startsWith('d_'), true);
  assertEquals(added.moments[0].id.startsWith('m_'), true);
});

Deno.test('set_booking attaches a booking to the activity', () => {
  const next = applyPatch(baseContent(), {
    ops: [{ op: 'set_booking', activity_id: 'a1', booking: { name: 'Ferry', ref: 'XYZ' } }],
  });
  assertEquals(next.days[0].moments[0].activities[0].booking?.ref, 'XYZ');
});

Deno.test('move_activity relocates between moments', () => {
  const content = baseContent();
  content.days[0].moments.push({ id: 'm2', slot: 'evening', title: 'Dinner', activities: [] });
  const next = applyPatch(content, {
    ops: [{ op: 'move_activity', activity_id: 'a1', to_moment_id: 'm2' }],
  });
  assertEquals(next.days[0].moments[0].activities.length, 0);
  assertEquals(next.days[0].moments[1].activities[0].id, 'a1');
});

Deno.test('update_activity merges fields and never overwrites id', () => {
  const next = applyPatch(baseContent(), {
    ops: [
      { op: 'update_activity', activity_id: 'a1', set: { title: 'Long walk', body: 'Scenic' } },
    ],
  });
  const a = next.days[0].moments[0].activities[0];
  assertEquals(a.id, 'a1');
  assertEquals(a.title, 'Long walk');
  assertEquals(a.body, 'Scenic');
});

Deno.test('a missing target id throws PatchError (atomic reject)', () => {
  assertThrows(
    () =>
      applyPatch(baseContent(), {
        ops: [{ op: 'set_booking', activity_id: 'nope', booking: { name: 'X' } }],
      }),
    PatchError,
  );
});

Deno.test('validatePatchShape flags unknown ops and missing fields', () => {
  assertEquals(validatePatchShape({ ops: [] }).length > 0, true);
  assertEquals(validatePatchShape({ ops: [{ op: 'frobnicate' }] }).length > 0, true);
  assertEquals(validatePatchShape({ ops: [{ op: 'set_day_summary', day_id: 'd1' }] }).length, 1);
  assertEquals(
    validatePatchShape({ ops: [{ op: 'set_booking', activity_id: 'a1', booking: { name: 'X' } }] })
      .length,
    0,
  );
});
