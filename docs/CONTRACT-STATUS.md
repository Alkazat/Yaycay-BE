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

Current version: **`0.4.0`**. Pin `@alkazat/contracts@^0.4.0` (the admin surface
that earlier handoffs called `^0.2.0` ships within this range).

GitHub Packages requires auth to install **even public packages**. Each consumer
(and their CI) needs a GitHub token with `read:packages`:

```
# ~/.npmrc (user-level, keep the token out of committed files)
//npm.pkg.github.com/:_authToken=<token with read:packages>
```

## Live deployment (free tier)

Deployed to the Supabase project `nzmjkbjtcjthjwdscjrj` (free tier — no custom
domain). There is **no `api.yaycay.ai` gateway**, so the OpenAPI `servers` block
is aspirational; consumers use the function base URL below via an env var (do not
hard-code it — a future domain switch should be one line).

```
NEXT_PUBLIC_API_BASE=https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1
NEXT_PUBLIC_SUPABASE_URL=https://nzmjkbjtcjthjwdscjrj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key — Supabase → Settings → API>
```

There are two environments. Production deploys from `main` (the project above);
a separate **staging** project deploys from `develop` — point staging builds at
`https://<STAGING_PROJECT_REF>.supabase.co/functions/v1`. Same path rules apply
to both.

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
| `POST /checkout/session` | `CheckoutSessionResponse` (Stripe Checkout URL) | ✅ served (v0.5) |
| `POST /webhooks/stripe` | `{ received }` (signature-verified; flips trip tier) | ✅ served (v0.5) |

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
| BYO-AI connector | `POST /connectors/byo-ai`, `GET /connectors`, `POST /mcp` | BYO-AI MCP |

### Commerce setup (Stripe)

`/checkout/session` validates the `price_id` against the `products` table, so each
Stripe price must be seeded there with the tier it grants, e.g.:

```sql
insert into public.products (price_id, name, amount_usd, tier) values
  ('price_xxx_ours', 'Use Our AI', 49, 'ours'),
  ('price_xxx_byo',  'Bring Your Own AI', 29, 'byo');
```

Stripe keys are per environment (test on staging, live on prod). Add repo
secrets: production uses `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`; staging
uses `STAGING_STRIPE_SECRET_KEY` / `STAGING_STRIPE_WEBHOOK_SECRET`. The deploy
pushes whichever matches the target as `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
to the project (plus optional `CHECKOUT_SUCCESS_URL` / `CHECKOUT_CANCEL_URL`).
Point each environment's Stripe webhook at that project's
`…/functions/v1/stripe-webhook`.
