# Contract status — `@alkazat/contracts`

BE owns the contract; FE, Admin and Website consume it. This file tracks what is
**published and served**, what is **reconciled but pending publish**, and what is
**deferred**, so consumers can see progress as BE delivers. Source of truth is
`packages/contracts/openapi.yaml`; this is the human-readable index.

## Package scope (action for consumers)

The package is **`@alkazat/contracts`** (published to GitHub Packages). Earlier
notes referenced `@yaycay/contracts` — that name is **not** published. Consumers
must update their imports and pins to `@alkazat/contracts` and point npm at the
GitHub Packages registry for the `@alkazat` scope:

```
# .npmrc
@alkazat:registry=https://npm.pkg.github.com
```

## Admin auth claim shape (answer to the Admin thread)

`role` is **not** a JWT claim. The flow is:

1. The gateway verifies the JWT signature (`verify_jwt = true`).
2. The handler reads `sub` and `aal` from the token and requires `aal === 'aal2'`
   (verified MFA).
3. `role` is resolved server-side from the **isolated identity store**:
   `identity.accounts.role` keyed by `user_id = sub`. Only `role = 'admin'` passes.

So `getAdminSession()` should read `aal` from the session JWT and treat role as
server-resolved (not a claim). Audit sink is `public.admin_audit_log`
(append-only; every `/admin/*` write is logged via the service role).

## Customer surface

| Method + path | Returns | Status |
|---|---|---|
| `POST /demo/generate-day` | `DemoGenerateDayResponse` | ✅ served |
| `POST /signup/capture` | `SignupCaptureResponse` (+ Brevo sync) | ✅ served |
| `POST /auth/2fa/verify` | `TwoFactorVerifyResponse` | ✅ served |
| `GET /trips` | `{ trips: TripSummary[] }` incl. `day_count`, `data_kept` | ✅ served (v0.4) |
| `POST /trips` | `Trip` | ✅ served |
| `GET /trips/:id` | `TripContent` (the §5 payload) | ✅ served (v0.4) |
| `GET /trips/:id/content` | `TripContent` (alias of the above) | ✅ served |
| `PATCH /trips/:id/content` | `TripContent` (schema-validated) | ✅ served |
| `POST /trips/:id/plan/chat` | SSE `PlanChatEvent` stream (tier=ours) | ✅ served (v0.3) |
| `POST /trips/:id/ingest` | `IngestResponse` (paid: byo/ours) | ✅ served (v0.3) |

### v0.1 reconciliations (resolved)

- **`GET /trips/:id`** now returns `TripContent` (matches FE / model-context §5),
  not trip metadata. Per-trip metadata (tier, status, retention) is carried on
  the `TripSummary` from `GET /trips`. The old `GET /trips/:id/content` remains as
  an alias so existing callers keep working.
- **`TripSummary`** gained `day_count` (derived from the content) and `data_kept`
  (false once past the retention/disposal date).
- **`TripStatus`** is the full enum
  (`draft|planning|ready|holidaying|complete|archived`); the FE's
  `planning|ready|complete` is a valid subset.

## Deferred (not yet served — do not call)

These are specced by consumers but not built. They will be added to the contract
**when the handler ships**, to keep the contract truthful.

| Need | Planned shape | Slice |
|---|---|---|
| Child profiles | `GET /profiles -> { profiles: ChildProfile[] }` | profiles/progress |
| Per-profile progress | `GET/PATCH /trips/:id/progress` | profiles/progress |
| Account summary | `GET /account -> AccountSummary` | account |
| Journal | `GET/POST /trips/:id/journal` (`JournalEntry`) | journal/media |
| Media upload | `POST /media/sign-upload` (signed-URL flow) | journal/media |
| Checkout | `POST /checkout/session` (`{ price_id, trip_id? } -> { url }`) — canonical path is `/checkout/session`, not `/checkout` | Stripe |
| Stripe webhook | `POST /webhooks/stripe` (entitlement, idempotent) | Stripe |
| BYO-AI connector | `POST /connectors/byo-ai`, `GET /connectors`, `POST /mcp` | BYO-AI MCP |
