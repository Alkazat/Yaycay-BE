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

Current version: **`0.16.0`**. Pin `@alkazat/contracts@^0.16.0` (the admin surface
that earlier handoffs called `^0.2.0` ships within this range).

GitHub Packages requires auth to install **even public packages**. Each consumer
(and their CI) needs a GitHub token with `read:packages`:

```
# ~/.npmrc (user-level, keep the token out of committed files)
//npm.pkg.github.com/:_authToken=<token with read:packages>
```

## Live deployment (free tier)

Deployed to Supabase Edge Functions (free tier, no custom domain). There is **no
`api.yaycay.ai` gateway**, so the OpenAPI `servers` block is aspirational;
consumers use the function base URL below via an env var (do not hard-code it, so
a future domain switch is one line).

Two environments, mapped to branches and repo secrets:

- **Production** deploys from `main` to the project in `SUPABASE_PROJECT_REF`.
- **Staging** deploys from `develop` to the project in `STAGING_PROJECT_REF`.

The base URL per environment is `https://<project-ref>.supabase.co/functions/v1`
(get the ref + anon key from that project's Supabase dashboard, Settings -> API):

```
# production (swap the ref for STAGING_PROJECT_REF to target staging)
NEXT_PUBLIC_API_BASE=https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1
NEXT_PUBLIC_SUPABASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<that project's anon public key>
```

The same path rules below apply to both environments.

Without a gateway, endpoint paths are the **function names**. Three contract
paths map to hyphenated functions; the rest match:

| Contract path | Live URL (append to `NEXT_PUBLIC_API_BASE`) |
|---|---|
| `POST /demo/generate-day` | `/demo-generate-day` |
| `POST /signup/capture` | `/signup-capture` |
| `POST /auth/2fa/verify` | `/auth-2fa-verify` |
| `/trips`, `/trips/:id`, `/trips/:id/content`, `/trips/:id/plan/chat`, `/trips/:id/ingest` | `/trips…` (matches) |
| `/admin/*` | `/admin/*` (matches) |

Headers: every request sends `apikey: <anon key>`; authenticated routes also
`Authorization: Bearer <user JWT>`. When a custom domain / gateway is added later,
the clean contract paths (`/demo/generate-day`, …) can be served via a path-rewrite
proxy, and this table goes away.


## Admin surface (v0.2) — reconciliation for the Admin thread

The full `/admin/*` surface from the Admin handoff is built and matches the
proposed DTOs verbatim, with **one rename**:

- **`TripSummary` → `AdminTripSummary`.** Fields are identical
  (`id, destination, ownerEmail, tier, status, startDate, endDate,
  retentionExpiresAt`); only the name changed. v0.4 gave the canonical
  `TripSummary` name to the customer surface (snake_case, with `day_count` /
  `data_kept`), so the admin off-domain row is now `AdminTripSummary`. It is what
  `getTripSummary` returns and what `TripSummaryPage.items` holds. **Admin:
  import `AdminTripSummary`.**

All other admin DTOs are unchanged: `Role`, `TripTier`, `AiModel`, `AiJobKind`,
`AiJobStatus`, `Prompt`, `ModelRoute`, `AiJob`, `JobCapUsage`, `CustomerSummary`,
`ProductSummary`, `PurchaseSummary`, `ContentReviewItem`, and the
`TripDay`/`TripMoment`/`TripActivity` aliases of the canonical content model.

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
| `GET/POST /trips/:id/journal` | `JournalEntry` incl. `mood`, 1-5 `stars`, `day_id` (POST paid) | ✅ served (v0.6; mood/stars v0.10; day_id v0.14) |
| `POST /media/sign-upload` | `SignUploadResponse` (signed Storage URL, paid) | ✅ served (v0.6) |
| `POST /connectors/byo-ai` · `GET /connectors` · `POST /mcp` | BYO-AI MCP (tier=byo) | ✅ served (v0.6) |
| `GET /profiles` · `POST /profiles` · `PATCH/DELETE /profiles/:id` | `ChildProfile` (CRUD; incl. `type` child/guardian + `pin_set`) | ✅ served (v0.9; type/pin v0.15) |
| `POST /profiles/:id/pin` · `POST /profiles/:id/pin/verify` | guardian PIN set + verify (hashed, rate-limited; `PinVerifyResponse`) | ✅ served (v0.15) |
| `GET /trips/:id/progress` · `PATCH /trips/:id/progress` | `TripProgress` (per-profile done + active mode) | ✅ served (v0.9) |
| `GET /trips/:id/stars` · `POST /trips/:id/stars/claim` | `StarsResponse` · `StarClaimResponse` (idempotent per child/day/source) | ✅ served (v0.11) |
| `GET /trips/:id/packing` · `PATCH /trips/:id/packing` | `PackingResponse` `{ lists }`; PATCH action = tick\|add\|delete\|reset, returns the whole collection | ✅ served (v0.12) |
| `GET/PATCH /trips/:id/grownups/checklist` | `ChecklistResponse` (persisted ticks) | ✅ served (v0.11) |
| `GET /admin/me` | `AdminSession` (role + MFA) | ✅ served (v0.6) |
| `GET /admin/products` | `{ items: ProductSummary[] }` (all, incl. inactive) | ✅ served (v0.8) |
| `POST /admin/products` | `ProductSummary` (add a catalogue product) | ✅ served (v0.8) |
| `PATCH /admin/products/:priceId` | `ProductSummary` (edit price/kind/entitlement/active) | ✅ served (v0.8) |
| `GET /admin/admins` · `POST /admin/admins` | `AdminAccount` (list admins; set role by email — 404 if no account yet) | ✅ served (v0.14) |
| `GET/POST /admin/affiliates` · `GET/PATCH /admin/affiliates/:code` · `GET …/redemptions` · `POST …/report` | affiliate program: create (Stripe coupon+promo), pause, attributed redemptions, monthly Brevo report | ✅ served (v0.16) |
| `POST /checkout/session` | `CheckoutSessionResponse` (Stripe Checkout URL) | ✅ served (v0.5) |
| `POST /webhooks/stripe` | `{ received }` (tier flip **or** keep-token retention extension) | ✅ served (v0.5/v0.8) |

### Phase 2: retention, disposal, and the keep-token (v0.8)

- **Retention default.** Every trip gets `retention_expires_at` on creation —
  12 months after the holiday (`end_date`/`start_date`, else today). FE already
  surfaces this via `TripSummary.data_kept` (false once past the date).
- **Keep-token upsell.** A product with `kind: 'keep'` and `extendsMonths` is a
  keep-token. `POST /checkout/session` with that price (a `trip_id` is required)
  → on the completed-checkout webhook the trip's `retention_expires_at` is pushed
  forward by `extendsMonths` (from the later of now and the current expiry).
  Tier products (`kind: 'tier'`) still confer `byo`/`ours` as before.
- **Product kinds.** `ProductSummary` now carries `kind` (`tier|keep`),
  `extendsMonths`, and `active`. Admin manages the catalogue via `POST`/`PATCH
  /admin/products`; the customer catalogue read remains active-only.
- **Disposal job.** A daily sweep deletes trips past their retention date. It
  runs in-DB via pg_cron where available, and is also exposed as an internal
  `POST /disposal` edge endpoint (guarded by `DISPOSAL_SECRET`, header
  `x-disposal-secret`) for an external scheduler. Not a consumer endpoint — it
  is infrastructure, so it is not in the OpenAPI client surface.

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
| Account summary | `GET /account -> AccountSummary` | account |

**Profiles + progress shipped (v0.9).** `GET/POST /profiles`,
`PATCH/DELETE /profiles/:id`, and `GET/PATCH /trips/:id/progress` are now served
(profiles run as `/profiles`, progress under `/trips`). The profile `mode` enum
is `little|standard|explorer|explorer_plus` — the FE's `standard` is included.
The admin inspection shape was renamed **`ChildProfile` → `AdminChildProfile`**
(same precedent as `AdminTripSummary`) so the canonical customer `ChildProfile`
is unambiguous; **Admin: import `AdminChildProfile`.**

### Commerce setup (Stripe)

`/checkout/session` validates the `price_id` against the `products` table, so each
Stripe price must be seeded there with the tier it grants, e.g.:

```sql
-- tier products grant an entitlement; a keep-token extends retention.
insert into public.products (price_id, name, amount_usd, kind, tier, extends_months) values
  ('price_xxx_ours', 'Use Our AI',        49, 'tier', 'ours', null),
  ('price_xxx_byo',  'Bring Your Own AI', 29, 'tier', 'byo',  null),
  ('price_xxx_keep', 'Keep our memories', 9,  'keep', null,   12);
```

Or manage the catalogue from Admin via `POST`/`PATCH /admin/products` — no SQL.

Stripe keys are per environment (test on staging, live on prod). Add repo
secrets: production uses `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`; staging
uses `STAGING_STRIPE_SECRET_KEY` / `STAGING_STRIPE_WEBHOOK_SECRET`. The deploy
pushes whichever matches the target as `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
to the project (plus optional `CHECKOUT_SUCCESS_URL` / `CHECKOUT_CANCEL_URL`).
Point each environment's Stripe webhook at that project's
`…/functions/v1/stripe-webhook`.
