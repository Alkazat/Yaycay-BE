# Yaycay Back-End - Handoff

**Repo:** `github.com/Alkazat/Yaycay-BE`
**Read `00-MODEL-CONTEXT.md` first.** This thread **owns the shared contract** (`@yaycay/contracts`). FE, Admin and Website depend on what you publish, so the contract is your primary deliverable alongside the code.

---

## Mission

The platform core: the API, the database + RLS, the model-agnostic AI harness, the BYO-AI MCP endpoint, Stripe, and the Brevo sync. Thin, serverless, scales to zero, smoke-tested on every deploy.

## Scope

**In:** schema + migrations + RLS; the HTTP API; the contract package (OpenAPI + generated TS types + JSON schemas); auth wiring (2FA, secondary-email reset, isolated identity store); AI orchestration (generation + ingestion, daily cap); the MCP endpoint; Stripe Checkout + webhook → entitlement; Brevo contact sync; signed-URL issuance for media.

**Out:** UI (FE/Admin/Website); AI inference billed to the BYO customer (their model runs it); prompt authoring UX (Admin edits, BE stores/serves).

## Stack

- **Supabase**: Postgres (+ RLS), Auth, Storage, **Edge Functions** (Deno/TypeScript) for custom endpoints; PostgREST for straight CRUD where RLS suffices.
- TypeScript. AI harness wraps Claude / Gemini / OpenAI (default **Sonnet** for use-our-AI). Stripe SDK. Brevo API.
- **Identity isolation:** a dedicated Supabase project (or locked-down `identity` schema) for `accounts`/auth, separate from the app DB; join by `user_id`.

## You own the contract

Publish `@yaycay/contracts` containing:
- `openapi.yaml` (3.1) - every endpoint below.
- generated `*.d.ts` - request/response DTOs + `TripContent`.
- `schemas/trip-content.schema.json` and the MCP tool input schemas.
- semver; tag releases; CI publishes to GitHub Packages. Consumers pin a range.

## Data model

Implement §4–§5 of the model context. RLS on every customer table; admins (`role=admin`) bypass per-family scoping. Validate `trip_content` writes against the JSON schema. `retention_expires_at` drives the disposal job (default 12 months; extended by a keep-token purchase).

## API surface (illustrative; finalise in the contract)

| Method + path | Purpose | Auth |
|---|---|---|
| `POST /demo/generate-day` | One AI-built day for the free demo | public (rate-limited) |
| `POST /signup/capture` | Create/lead-capture + Brevo sync (used by Website + FE demo) | public |
| `POST /auth/2fa/verify` | Verify the one-time email code | session |
| `GET /trips` · `POST /trips` · `GET /trips/:id` | Trip CRUD | user |
| `GET /trips/:id/content` · `PATCH /trips/:id/content` | Read/mutate the trip JSON (validated) | user |
| `POST /trips/:id/plan/chat` | Use-our-AI guarded Sonnet chat (streaming) | user (tier=ours) |
| `POST /trips/:id/ingest` | Receipt/photo/booking → itinerary update (counts to daily cap) | user (paid) |
| `GET /trips/:id/progress` · `PATCH …` | Per-profile state (by `profile_id`) | user |
| `POST /trips/:id/journal` · `POST /media/sign-upload` | Journal + print-grade media | user (paid) |
| `POST /connectors/byo-ai` | Provision an MCP token for the parent's agent | user (tier=byo) |
| `POST /mcp` (+ tool routes) | Authenticated MCP endpoint (see below) | connector token |
| `POST /checkout/session` | Create a Stripe Checkout session for a price ID | user |
| `POST /webhooks/stripe` | Set entitlement on success | Stripe sig |
| `GET /admin/*` | Admin-scoped reads/writes (prompts, jobs, trips) | admin |

## AI harness

- **Interface:** `generate(promptVersion, model, input) -> TripContentPatch` and `ingest(model, media|text) -> TripContentPatch`. Patches are validated then applied to `trip_content`.
- **Generation** builds Holiday → Days → Moments → Activities, with per-mode `variants` (`little`, `explorer_plus`) and `safety` flags from profile dietary/medical data.
- **Ingestion** (OCR a receipt/booking/flight, or a note) updates the right day/moment. Vision-capable model. Each call writes an `ai_jobs` row and **counts to the ~10/day cap per trip**; over the cap → queue for next day or require manual edit.
- **Model + prompt are config:** read the active `prompts` row (model, version) chosen in Admin; never hard-code prompts.

## BYO-AI MCP endpoint

- `POST /connectors/byo-ai` mints a scoped token; the parent adds it to their own ChatGPT/Claude/Gemini as a connector.
- Expose MCP tools (input schemas in the contract): `get_trip`, `list_days`, `add_activity`, `update_activity`, `move_activity`, `add_moment`, `import_reservation(text|image)`, `set_packing_list`, `optimise_day(day_id)`. All scoped to the token's account + trip; all writes validated against the schema; all logged in `ai_jobs` (no model cost to us).

## Payments + marketing

- `POST /checkout/session` creates Checkout for the requested price ID; `POST /webhooks/stripe` verifies the signature and writes `purchases` + flips the trip `tier`/entitlement. Idempotent.
- On signup, upsert `marketing_contacts` and sync to Brevo with consent; transactional emails (2FA, magic link) via the transactional sender.

## Environment / secrets

```
SUPABASE_URL= / SUPABASE_SERVICE_ROLE_KEY=
IDENTITY_SUPABASE_URL= / IDENTITY_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY= / OPENAI_API_KEY= / GEMINI_API_KEY=
STRIPE_SECRET_KEY= / STRIPE_WEBHOOK_SECRET=
BREVO_API_KEY=
MCP_TOKEN_SIGNING_SECRET=
```

## Build checklist

**Phase 0** - schema + RLS for `accounts`/`trips`/`trip_content`; `POST /demo/generate-day`; `POST /signup/capture` + Brevo; publish contract `v0.1`.
**Phase 1** - auth (2FA, reset, isolated identity); trip CRUD + content validation; our-AI chat; ingest + daily cap; journal + media signing; Stripe two-tier + webhook; BYO-AI MCP endpoint; contract `v0.2`; pgTAP RLS tests; CI + smoke.
**Phase 2** - admin endpoints (prompts/models/jobs); retention/disposal job + keep-token; product catalogue endpoints; upsell entitlements.

## Testing & CI

- Vitest (harness, entitlement, webhook idempotency).
- **pgTAP**: prove RLS isolation (account A cannot read B); identity-store separation.
- Contract tests: responses match the published OpenAPI.
- Local Supabase in Docker in CI. `develop` → staging project, `main` → prod project; migrations on deploy; smoke test hits `/demo/generate-day` and a seeded trip read.

## Definition of done

A family can sign up, buy either tier, plan via our Sonnet chat or their own AI over MCP, ingest updates within the cap, and their data is RLS-isolated and disposed on schedule - with the contract published and green consumers.

## Handshake

- You publish; FE/Admin/Website consume. Breaking change = major bump + a note in the release. Keep `v0.1` mockable early so others aren't blocked.
