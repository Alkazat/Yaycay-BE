// Deno tests for the Stripe webhook signature verification. No network: uses
// Web Crypto to sign, then checks constructEvent accepts/rejects correctly.
import { constructEvent, SignatureError } from './stripe.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, ctor: new () => Error): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ctor) return;
    throw new Error(`Threw ${err}, expected ${ctor.name}`);
  }
  throw new Error(`Expected ${ctor.name} to be thrown`);
}

const enc = (s: string) => new TextEncoder().encode(s);

async function sign(body: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc(`${t}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_1' } },
});

Deno.test('a correctly signed recent event is accepted and parsed', async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${await sign(BODY, SECRET, t)}`;
  const event = await constructEvent(BODY, header, SECRET);
  assert(event.type === 'checkout.session.completed', 'event type parsed');
});

Deno.test('a tampered body is rejected', async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${await sign(BODY, SECRET, t)}`;
  await assertThrowsAsync(() => constructEvent(BODY + ' ', header, SECRET), SignatureError);
});

Deno.test('the wrong secret is rejected', async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${await sign(BODY, 'whsec_other', t)}`;
  await assertThrowsAsync(() => constructEvent(BODY, header, SECRET), SignatureError);
});

Deno.test('an old timestamp is rejected (replay window)', async () => {
  const t = Math.floor(Date.now() / 1000) - 10_000;
  const header = `t=${t},v1=${await sign(BODY, SECRET, t)}`;
  await assertThrowsAsync(() => constructEvent(BODY, header, SECRET), SignatureError);
});

Deno.test('a malformed header is rejected', async () => {
  await assertThrowsAsync(() => constructEvent(BODY, 'not-a-signature', SECRET), SignatureError);
});
