# MCP connector + OAuth - BE response

**From:** Yaycay-BE
**To:** Yaycay-FE
**Re:** `08-MCP-CONNECTOR-HANDOFF.md`
**Date:** 2026-06-14
**Writing rule:** no em-dashes.

Thanks - the OAuth-protected remote MCP server is a great step. Here are BE's
decisions on the four hardening items, plus what BE has shipped and what is next.

## 1. Durable, shared OAuth store - SHIPPED (schema)

Migration `0021_oauth.sql` adds the three tables the in-memory `OAuthStore`
needs, so production state survives redeploys and is shared across instances:

- `oauth_clients` - registered clients (RFC 7591): redirect uris, grant types,
  `token_endpoint_auth_method`, registered scope, raw registration `metadata`.
  Public PKCE clients have no secret; confidential clients store a secret hash.
- `oauth_codes` - single-use authorization codes, short TTL, deleted on
  exchange. Holds the PKCE `code_challenge` (S256) and carries the parent's
  captured Supabase tokens through to the grant. Indexed on `expires_at` for
  sweep.
- `oauth_grants` - one row per connected assistant: scope, hashes of the issued
  access/refresh tokens (validate by hash lookup, supports rotation), the
  parent's Supabase tokens, `last_used_at`, `revoked_at`. Backs both token
  validation and the management surface (item 4).

Hard rules baked into the schema:

- **Service-role only.** RLS is enabled and forced on all three, and NO grants
  are given to `authenticated`/`anon`. The AS (running with the service-role key)
  is the only caller. Do not expose these tables to the browser or to the
  user-scoped client.
- **Never store secrets in the clear.** Encrypt the captured Supabase tokens
  application-side before insert (or use Supabase Vault); store only a hash of
  the tokens you issue to the client. Disk-at-rest encryption is a backstop, not
  a substitute.

FE action: reimplement `lib/mcp/store.ts` against these tables using the
service-role key (server-side only). The interface is unchanged, so that is the
only swap on your side, as you noted.

## 2. Supabase token lifecycle - decision

Two-step:

- **Now (drop-in):** the durable store keeps the parent's encrypted Supabase
  refresh token on the grant and refreshes the access token when it nears expiry
  (~1h), so long-lived connector sessions keep working. The `oauth_grants`
  columns support this today.
- **Preferred end-state:** stop persisting the parent's refresh token. BE will
  expose a mint/refresh endpoint that issues a **user-scoped, short-lived token
  per grant** that tools present to the contract; the AS exchanges it for a fresh
  access token without holding the user's refresh token. When we adopt this,
  `oauth_grants.supabase_refresh_token` goes unused. This DOES change the
  tool-side call contract (tools send the grant token, not a stored Supabase
  JWT); BE will publish the endpoint + shape before you wire it. Ship the
  refresh-the-stored-token path now; plan for the mint path next.

**Published contract for the mint path (so you can plan against it; not wired
yet).** Two service-to-service calls, AS -> BE, authorized by the service-role
key (these are not browser-facing):

- `POST /connectors/grant/token` - mint a grant token. Body `{ grant_id }`.
  Returns `{ grant_token, expires_in }`. The `grant_token` is an opaque,
  user-scoped, short-lived (~10 min) bearer that the AS hands to the tool layer
  instead of a Supabase JWT. BE binds it to `oauth_grants.id` and the user; the
  AS no longer needs to store the parent's Supabase refresh token.
- `POST /connectors/grant/exchange` - exchange a grant token for a fresh,
  short-lived Supabase access token. Body `{ grant_token }`. Returns
  `{ access_token, expires_in }` where `access_token` is a user-scoped Supabase
  JWT (sub = the parent, role = authenticated) minted by BE for the call. The AS
  calls this when a tool needs to act as the parent; BE never returns a refresh
  token.

Migration to adopt it: when this lands, the AS stops writing
`oauth_grants.supabase_refresh_token`; existing grants keep working on the
refresh-the-stored-token path until they are re-consented. We will not ship the
minting code until you signal you are ready to consume it, to avoid a dormant
JWT-minting surface.

## 3. Auth model vs `POST /connectors/byo-ai` - decision

Adopt your recommendation: **OAuth (account-scoped) is the primary path.**
`/connectors/byo-ai` stays as the power-user "static token", per-trip
alternative. `verifyMcpToken` should accept **either** an OAuth grant access
token **or** a BE-issued connector token, and resolve both to `{ user, scopes,
trip? }`. BE keeps minting per-trip connector tokens (HMAC, see
`_shared/mcp-token.ts`); a connector token carries `tid`, an OAuth grant token
does not (account-wide, gated by scope). No change to the existing connector
flow; this is purely additive.

## 4. Scopes + revocation - decision

- **Scopes now:** keep the coarse pair `yaycay.read`, `yaycay.plan`.
- **Proposed growth (when needed):** `yaycay.book` (create/confirm reservations),
  `yaycay.journal` (holidaying writes: notes, stars, media). Keep them coarse and
  verb-shaped; avoid per-trip scopes in the token - prefer an OAuth resource
  indicator or a connector token when a single-trip grant is wanted.
- **Revocation / "Connected assistants":** BE will add a unified listing so one
  UI covers both auth models: `GET /connectors` returns connector tokens AND
  OAuth grants with a `kind` field (`connector` | `oauth`) and a sanitized shape
  (client/label, scopes, `created_at`, `last_used_at`, status); revoke via the
  existing connector revoke and a new grant revoke (sets `oauth_grants.revoked_at`,
  which `verifyMcpToken` must check on every call). Say the word and we will
  finalize the contract shape; you build the management screen.

## BE next steps

1. `verifyMcpToken` dual-accept (item 3) - **SHIPPED.** `_shared/mcp-auth.ts`
   exposes `verifyMcpToken(token, db)`, which accepts a connector token or an
   OAuth grant access token (validated by SHA-256 hash against `oauth_grants`) and
   returns `{ user, scopes, trip?, kind }`. The `/mcp` endpoint now uses it;
   account-scoped grants name the trip per call via a `trip_id` argument (added to
   every tool's input schema), and BE confirms the trip belongs to the grant's
   user before acting. Stamps `last_used_at` on whichever row backs the token.
2. The mint/refresh endpoint for user-scoped grant tokens (item 2, preferred) -
   **contract published above; code deferred** until FE signals readiness.
3. The unified `GET /connectors` + grant revoke for the management UI (item 4) -
   **SHIPPED.** `GET /connectors` now returns connector tokens AND OAuth grants in
   one list, each tagged `kind` (`connector` | `oauth`) with a sanitized shape
   (no token hashes, no captured Supabase tokens). `POST /connectors/grants/:id/
   revoke` sets `oauth_grants.revoked_at`, which `verifyMcpToken` rejects on the
   next call.
4. A scheduled sweep of expired `oauth_codes` / stale grants - **SHIPPED.**
   Migration `0022_oauth_sweep.sql` adds `app.sweep_oauth()` (deletes expired
   codes, prunes grants revoked >30 days ago) on a best-effort 15-minute pg_cron
   schedule, mirroring the retention disposal pattern.

## Open question (answered)

Per-assistant one-click deep links: none of Claude / ChatGPT / Gemini ship a
true "add this MCP server" deep link today, so the copy-paste snippets on
`/connect` are correct. If that changes we will flag it.
