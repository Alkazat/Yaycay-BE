# Yaycay Back-End

The platform core for Yaycay, the family holiday companion: the HTTP API, the
database and Row-Level Security, the model-agnostic AI harness, the BYO-AI MCP
endpoint, Stripe, and the Brevo sync. Thin, serverless, scales to zero.

**This thread owns the shared contract** (`@alkazat/contracts`). FE, Admin and
Website depend on what we publish, so the contract is the primary deliverable
alongside the code. See [`docs/00-MODEL-CONTEXT.md`](docs/00-MODEL-CONTEXT.md)
(read first) and [`docs/02-BACKEND-HANDOFF.md`](docs/02-BACKEND-HANDOFF.md).

## Status: Phase 0 + admin contract v0.2 + use-our-AI v0.3

The free-demo hook, lead capture, the core data model with RLS, contract `v0.1`,
the admin-scoped contract `v0.2` (plus its schema) for the Admin thread, and the
`v0.3` use-our-AI surfaces (streaming planning chat + structured ingestion).

| Area | Delivered |
|---|---|
| Contract | `openapi.yaml` (3.1), TS DTOs + `TripContent`, `schemas/trip-content.schema.json`, semver. **v0.2** adds the `/admin/*` surface (prompts, models, jobs, trips/customers, content review, commerce) with problem+json and cursor pagination. **v0.3** adds the planning-chat + ingestion DTOs and the shared `TripContentPatch` op vocabulary |
| Schema + RLS | `accounts` (isolated identity), `child_profiles`, `trips`, `trip_content`, `trip_progress`, `ai_jobs`, `marketing_contacts`; **v0.2** adds `prompts`, `model_routes`, `content_review`, `admin_audit_log`, `products`, `purchases`. RLS forced on every customer table; pgTAP isolation + admin-gating tests |
| Endpoints | Public: `POST /demo/generate-day`, `POST /signup/capture`. Customer (RLS-scoped): `GET /trips` (`TripSummary[]`), `POST /trips`, `GET /trips/:id` (`TripContent`), `GET/PATCH /trips/:id/content`, `POST /auth/2fa/verify`, **`POST /trips/:id/plan/chat`** (SSE, tier=ours), **`POST /trips/:id/ingest`** (paid). Admin: the full `/admin/*` surface. See `docs/CONTRACT-STATUS.md` for the consumer-facing index |
| CI | contract validation, lint, typecheck, Vitest, Deno typecheck + harness tests, pgTAP |

The customer `trips` function runs as the caller (JWT forwarded) so RLS enforces
ownership; content writes are schema-validated. The v0.3 AI surfaces live in the
same function: `/plan/chat` streams a guarded Sonnet reply, `/ingest` turns a
receipt/photo/note into a validated `TripContentPatch` applied to the content.
Both log an `ai_jobs` row and honour the per-trip daily cap (default 10/day,
shared with the admin meter). The harness defaults to Claude Sonnet and falls
back to a deterministic path with no API key, so the surfaces work offline.
`auth-2fa-verify` verifies the caller's TOTP factor via Supabase MFA (elevates
to AAL2). The `admin` function enforces `role=admin` + AAL2, audits every call,
and returns problem+json. Still to come: journal/media, Stripe, MCP, and the
rest of Phase 2 (retention/disposal). Full MFA enrolment is Phase 1 too.

## Layout

```
packages/contracts/      @alkazat/contracts: openapi.yaml, schemas/, src/ (DTOs)
supabase/migrations/     0001 identity, 0002 app core, 0003 RLS, 0004 admin v0.2
supabase/functions/      Deno edge functions (demo, signup, trips, auth-2fa, admin) + _shared
supabase/tests/          pgTAP RLS isolation + admin-gating tests
docs/                    model context + backend handoff
```

## Develop

```bash
npm install
npm run contracts:validate   # parse OpenAPI + compile the JSON schema
npm run build                # build @alkazat/contracts
npm run lint && npm run typecheck && npm test
```

### Database + functions (requires the Supabase CLI + Docker)

```bash
supabase start               # local Postgres, applies migrations
supabase test db             # pgTAP RLS isolation tests
supabase functions serve     # demo-generate-day, signup-capture
```

`POST /demo/generate-day` works with no AI key (deterministic fallback);
set `ANTHROPIC_API_KEY` to generate with Claude Sonnet. See
[`.env.example`](.env.example) for all secrets. Secrets are server-side only.

## The contract is the handshake

FE / Admin / Website never call an endpoint or read a field that is not in the
contract, and BE never ships a breaking change without a major version bump. A
consuming thread that needs a new field opens a PR here; BE implements it,
bumps the version, and publishes. The current version is exported as
`CONTRACT_VERSION`.

### Releasing the contract

`@alkazat/contracts` publishes to GitHub Packages from
`.github/workflows/publish-contracts.yml`, triggered by a version tag:

```bash
# bump packages/contracts/package.json (e.g. 0.2.0), merge, then:
git tag contracts-v0.2.0
git push origin contracts-v0.2.0
```

The workflow checks the tag matches `package.json`, validates and builds the
package, and runs `npm publish`. When pushing a tag is not possible, the same
workflow can be run manually: Actions -> **Publish contracts** -> Run workflow,
entering the version (it still must match `package.json`). Consumers install
with an `.npmrc`:

```
@alkazat:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The package scope (`@alkazat`) matches the repository owner, which is what
GitHub Packages requires for publishing.

## Branching and deploy

- **`develop`** is the default and integration branch; feature branches PR into it.
- **`main`** is production.
- Deploys are automatic (`.github/workflows/deploy.yml`):
  - merge to `develop` -> deploys the **staging** project (`STAGING_PROJECT_REF`)
  - merge to `main` -> deploys **production** (`SUPABASE_PROJECT_REF`)
  - each run applies migrations (`supabase db push`), then `supabase functions deploy`
- **Ship to prod** by promoting: open a `develop` -> `main` PR; merging it deploys production.
- **Ad-hoc:** Actions -> **Deploy** -> Run workflow -> pick `staging` or `production`.
- Deploy secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD`
  (prod), `STAGING_PROJECT_REF` / `STAGING_DB_PASSWORD` (staging); optional
  `ANTHROPIC_API_KEY`, `BREVO_API_KEY`. The platform injects `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` into functions automatically.

## Conventions

TypeScript everywhere, Node 20. Branch/deploy model above (`develop` -> staging,
`main` -> production); every PR runs the full suite and blocks merge on failure.
Conventional commits. Writing rule for all docs and copy: no em-dashes.
