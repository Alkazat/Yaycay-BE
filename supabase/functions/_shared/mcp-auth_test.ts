// Deno tests for verifyMcpToken (the dual-accept resolver). Offline: the OAuth
// path is exercised with a tiny fake service client; the connector path uses the
// real HMAC mint. Run with --allow-env (the signing secret is read from env).
import { mintToken } from './mcp-token.ts';
import { McpAuthError, sha256Hex, verifyMcpToken } from './mcp-auth.ts';

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

// Minimal fake of the supabase-js builder surface used by verifyMcpToken:
//   from(t).select(...).eq(...).maybeSingle()  -> { data }
//   from(t).update(...).eq(...)                -> awaited (no-op)
// `rows` maps a table name to the row maybeSingle() should return.
function fakeDb(rows: Record<string, unknown>) {
  const builder = (table: string) => {
    const q = {
      select: () => q,
      update: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: rows[table] ?? null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null }),
    };
    return q;
  };
  // deno-lint-ignore no-explicit-any
  return { from: builder } as any;
}

Deno.test('connector token resolves to a per-trip connector grant', async () => {
  const token = await mintToken({
    cid: 'c1',
    uid: 'u1',
    tid: 't1',
    scope: ['get_trip'],
    iat: 1700000000,
  });
  const db = fakeDb({
    connectors: { id: 'c1', user_id: 'u1', trip_id: 't1', scopes: ['get_trip'], revoked_at: null },
  });
  const auth = await verifyMcpToken(token, db);
  assert(auth.kind === 'connector', 'kind is connector');
  assert(auth.user === 'u1', 'user resolved');
  assert(auth.trip === 't1', 'trip is bound');
  assert(auth.scopes.length === 1 && auth.scopes[0] === 'get_trip', 'scopes resolved');
});

Deno.test('a revoked connector is rejected', async () => {
  const token = await mintToken({ cid: 'c1', uid: 'u1', tid: 't1', scope: [], iat: 1 });
  const db = fakeDb({
    connectors: { id: 'c1', user_id: 'u1', trip_id: 't1', scopes: [], revoked_at: '2020-01-01' },
  });
  await assertRejects(() => verifyMcpToken(token, db), McpAuthError);
});

Deno.test('an OAuth grant access token resolves account-wide (no trip)', async () => {
  const opaque = 'opaque-access-token-value';
  const db = fakeDb({
    oauth_grants: {
      id: 'g1',
      user_id: 'u2',
      scope: 'yaycay.read yaycay.plan',
      access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      revoked_at: null,
    },
  });
  const auth = await verifyMcpToken(opaque, db);
  assert(auth.kind === 'oauth', 'kind is oauth');
  assert(auth.user === 'u2', 'user resolved');
  assert(auth.trip === undefined, 'no trip bound (account-scoped)');
  assert(auth.scopes.length === 2, 'space-delimited scopes split');
});

Deno.test('an expired OAuth grant is rejected', async () => {
  const db = fakeDb({
    oauth_grants: {
      id: 'g1',
      user_id: 'u2',
      scope: 'yaycay.read',
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      revoked_at: null,
    },
  });
  await assertRejects(() => verifyMcpToken('some-opaque-token', db), McpAuthError);
});

Deno.test('an unknown token is rejected', async () => {
  const db = fakeDb({});
  await assertRejects(() => verifyMcpToken('nope', db), McpAuthError);
});

Deno.test('sha256Hex is stable and hex-encoded', async () => {
  const a = await sha256Hex('abc');
  assert(
    a === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'known SHA-256 of "abc"',
  );
});
