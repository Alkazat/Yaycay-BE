// Deno tests for briefText (pure rendering; no DB). Run offline.
import { briefText, type TripIntent } from './trip-intent.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test('null or empty intent renders to an empty string', () => {
  assert(briefText(null) === '', 'null -> empty');
  assert(briefText({}) === '', 'empty -> empty');
  assert(briefText({ travellers: [] }) === '', 'no useful fields -> empty');
});

Deno.test('a populated brief renders the fields it has', () => {
  const intent: TripIntent = {
    pace: 'relaxed',
    budget: 'moderate',
    travellers: [{ name: 'Mia', age: 6, interests: ['dinosaurs'] }],
    interests: ['beaches'],
    must_do: ['cable car'],
    avoid: ['long museums'],
    notes: 'easy mornings please',
    constraints: { nap: '13:00-15:00' },
  };
  const text = briefText(intent);
  assert(text.includes("The family's brief"), 'has header');
  assert(text.includes('Mia, age 6, likes dinosaurs'), 'traveller line');
  assert(text.includes('Pace: relaxed'), 'pace');
  assert(text.includes('Must-do: cable car'), 'must-do');
  assert(text.includes('Avoid: long museums'), 'avoid');
  assert(text.includes('easy mornings please'), 'notes');
  assert(text.includes('nap'), 'constraints');
});

Deno.test('partial intent omits absent fields', () => {
  const text = briefText({ pace: 'packed' });
  assert(text.includes('Pace: packed'), 'pace present');
  assert(!text.includes('Budget'), 'no budget line');
  assert(!text.includes('Travellers'), 'no travellers line');
});
