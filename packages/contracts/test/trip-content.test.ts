import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { ActivityKind, TripContent } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'schemas', 'trip-content.schema.json');

let validate: ValidateFunction;

beforeAll(async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  validate = ajv.compile(schema);
});

const goodContent: TripContent = {
  trip: {
    id: 't_123',
    destination: 'Singapore',
    start_date: '2026-06-26',
    end_date: '2026-07-07',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
  },
  days: [
    {
      id: 'd_1',
      date: '2026-06-26',
      label: 'Arrival',
      moments: [
        {
          id: 'm_1',
          slot: 'afternoon',
          title: 'Sentosa beaches',
          time_hint: '15:00',
          location: { name: 'Siloso Beach', lat: 1.255, lng: 103.81 },
          activities: [
            {
              id: 'a_1',
              kind: 'kid',
              title: 'Beach treasure hunt',
              body: 'A playful hunt along the sand.',
              variants: {
                explorer_plus: {
                  fact: 'Sentosa means peace and tranquillity.',
                  quiz: { q: 'What does Sentosa mean?', a: 'Peace and tranquillity.' },
                },
              },
            },
            {
              id: 'a_2',
              kind: 'adult',
              title: 'Sunset drinks',
              booking: { name: 'Ola Beach Club', time: '18:30' },
              safety: { note: 'Lenny: nuts/legumes - confirm with kitchen.' },
            },
          ],
        },
      ],
    },
  ],
  grownups: { essentials: 'Pack light, sunscreen always.', checklist: ['Passports'] },
};

describe('trip-content.schema.json', () => {
  it('accepts a well-formed TripContent', () => {
    expect(validate(goodContent)).toBe(true);
  });

  it('rejects content missing required days', () => {
    const bad = { trip: goodContent.trip };
    expect(validate(bad)).toBe(false);
  });

  it('rejects an unknown activity kind', () => {
    const bad = structuredClone(goodContent);
    // deep path: days[0].moments[0].activities[0].kind
    bad.days[0]!.moments[0]!.activities[0]!.kind = 'grownup' as ActivityKind;
    expect(validate(bad)).toBe(false);
  });

  it('rejects additional unknown top-level properties', () => {
    const bad = { ...goodContent, surprise: true };
    expect(validate(bad)).toBe(false);
  });

  it('rejects an out-of-range latitude', () => {
    const bad = structuredClone(goodContent);
    bad.days[0]!.moments[0]!.location!.lat = 999;
    expect(validate(bad)).toBe(false);
  });
});
