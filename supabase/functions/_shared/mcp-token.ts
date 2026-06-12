// Scoped connector tokens for the BYO-AI MCP endpoint.
//
// A token is a compact `payload.signature` string (HMAC-SHA256 over the payload
// with MCP_TOKEN_SIGNING_SECRET). It carries the connector id, the owning user,
// and the single trip it is scoped to. The MCP endpoint verifies the signature,
// then resolves the connector row to confirm it is still active. No Supabase JWT
// is involved, so the trip scoping in the token is the authority.

import { requireEnv } from './env.ts';

export interface ConnectorClaims {
  /** connectors.id */
  cid: string;
  /** owning user id */
  uid: string;
  /** the single trip this token may touch */
  tid: string;
  scope: string[];
  iat: number;
}

function toB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(requireEnv('MCP_TOKEN_SIGNING_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintToken(claims: ConnectorClaims): Promise<string> {
  const payload = toB64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(
    'HMAC',
    await signingKey(),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${toB64Url(new Uint8Array(sig))}`;
}

export class TokenError extends Error {}

export async function verifyToken(token: string): Promise<ConnectorClaims> {
  const dot = token.indexOf('.');
  if (dot === -1) throw new TokenError('Malformed token');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ok = await crypto.subtle.verify(
    'HMAC',
    await signingKey(),
    fromB64Url(sig),
    new TextEncoder().encode(payload),
  );
  if (!ok) throw new TokenError('Bad signature');
  return JSON.parse(new TextDecoder().decode(fromB64Url(payload))) as ConnectorClaims;
}
