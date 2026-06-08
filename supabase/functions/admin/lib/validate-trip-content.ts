// Structural validation for trip_content on the edit-then-publish path. This
// mirrors the required-field rules of schemas/trip-content.schema.json. The
// canonical JSON schema lives in @yaycay/contracts; this is the runtime guard
// for writes that the edge runtime can execute without bundling the schema.

const SLOTS = ['morning', 'midday', 'afternoon', 'evening', 'night', 'anytime'];
const KINDS = ['kid', 'shared', 'adult'];

export function validateTripContent(input: unknown): string[] {
  const errors: string[] = [];
  const root = input as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return ['content must be an object'];

  const trip = root.trip as Record<string, unknown> | undefined;
  if (!trip || typeof trip !== 'object') {
    errors.push('trip is required');
  } else {
    for (const f of ['id', 'destination', 'start_date', 'end_date']) {
      if (typeof trip[f] !== 'string' || (trip[f] as string).length === 0) {
        errors.push(`trip.${f} is required`);
      }
    }
  }

  if (!Array.isArray(root.days)) {
    errors.push('days must be an array');
    return errors;
  }

  root.days.forEach((day, di) => {
    const d = day as Record<string, unknown>;
    if (typeof d.id !== 'string') errors.push(`days[${di}].id is required`);
    if (!Array.isArray(d.moments)) {
      errors.push(`days[${di}].moments must be an array`);
      return;
    }
    d.moments.forEach((moment, mi) => {
      const m = moment as Record<string, unknown>;
      const at = `days[${di}].moments[${mi}]`;
      if (typeof m.id !== 'string') errors.push(`${at}.id is required`);
      if (typeof m.title !== 'string' || (m.title as string).length === 0) {
        errors.push(`${at}.title is required`);
      }
      if (typeof m.slot !== 'string' || !SLOTS.includes(m.slot as string)) {
        errors.push(`${at}.slot must be one of ${SLOTS.join('|')}`);
      }
      if (!Array.isArray(m.activities)) {
        errors.push(`${at}.activities must be an array`);
        return;
      }
      m.activities.forEach((activity, ai) => {
        const a = activity as Record<string, unknown>;
        const aat = `${at}.activities[${ai}]`;
        if (typeof a.id !== 'string') errors.push(`${aat}.id is required`);
        if (typeof a.title !== 'string' || (a.title as string).length === 0) {
          errors.push(`${aat}.title is required`);
        }
        if (typeof a.kind !== 'string' || !KINDS.includes(a.kind as string)) {
          errors.push(`${aat}.kind must be one of ${KINDS.join('|')}`);
        }
      });
    });
  });

  return errors;
}
