// Deno tests for the connector token mint/verify (offline; uses Web Crypto).
// Run with --allow-env (the signing secret is read from the environment).
import { mintToken, verifyToken, TokenError, type ConnectorClaims } from './mcp-token.ts';

Deno.env.set('MCP_TOKEN_SIGNING_SECRET', 'test-signing-secret');

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function assertRejects(fn: () => Promise<unknown>, ctor: new () => Error): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ctor) return;
    throw new Error(`Threw ${err}, expected ${ctor.name}`);
  }
  throw new Error(`Expected ${ctor.name} to be thrown`);
}

const claims: ConnectorClaims = {
  cid: 'c1',
  uid: 'u1',
  tid: 't1',
  scope: ['get_trip', 'add_activity'],
  iat: 1700000000,
};

Deno.test('a minted token round-trips to the same claims', async () => {
  const token = await mintToken(claims);
  const back = await verifyToken(token);
  assert(back.cid === 'c1' && back.uid === 'u1' && back.tid === 't1', 'claims preserved');
  assert(back.scope.length === 2, 'scope preserved');
});

Deno.test('a tampered payload is rejected', async () => {
  const token = await mintToken(claims);
  const [, sig] = token.split('.');
  const forged = `${btoa('{"cid":"evil"}').replace(/=+$/, '')}.${sig}`;
  await assertRejects(() => verifyToken(forged), TokenError);
});

Deno.test('a malformed token is rejected', async () => {
  await assertRejects(() => verifyToken('not-a-token'), TokenError);
});
