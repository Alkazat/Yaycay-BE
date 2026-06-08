# Yaycay Back-End

The platform core for Yaycay, the family holiday companion: the HTTP API, the
database and Row-Level Security, the model-agnostic AI harness, the BYO-AI MCP
endpoint, Stripe, and the Brevo sync. Thin, serverless, scales to zero.

**This thread owns the shared contract** (`@yaycay/contracts`). FE, Admin and
Website depend on what we publish, so the contract is the primary deliverable
alongside the code. See [`docs/00-MODEL-CONTEXT.md`](docs/00-MODEL-CONTEXT.md)
(read first) and [`docs/02-BACKEND-HANDOFF.md`](docs/02-BACKEND-HANDOFF.md).

## Status: Phase 0 + admin contract v0.2

The free-demo hook, lead capture, the core data model with RLS, contract `v0.1`,
and the admin-scoped contract `v0.2` (plus its schema) for the Admin thread.

| Area | Delivered |
|---|---|
| Contract | `openapi.yaml` (3.1), TS DTOs + `TripContent`, `schemas/trip-content.schema.json`, semver. **v0.2** adds the `/admin/*` surface (prompts, models, jobs, trips/customers, content review, commerce) with problem+json and cursor pagination |
| Schema + RLS | `accounts` (isolated identity), `child_profiles`, `trips`, `trip_content`, `trip_progress`, `ai_jobs`, `marketing_contacts`; **v0.2** adds `prompts`, `model_routes`, `content_review`, `admin_audit_log`, `products`, `purchases`. RLS forced on every customer table; pgTAP isolation + admin-gating tests |
| Endpoints | `POST /demo/generate-day` (AI harness + deterministic fallback), `POST /signup/capture` (Brevo sync) |
| CI | contract validation, lint, typecheck, Vitest, Deno typecheck, pgTAP |

The `/admin/*` **handlers** are not yet implemented (v0.2 ships the contract +
migrations so Admin can pin `^0.2.0`). Phase 1 (auth, trip CRUD, our-AI chat,
ingest + daily cap, journal/media, Stripe, MCP) and the rest of Phase 2 (admin
endpoint handlers, retention/disposal) are still to come. AAL2 (MFA) gating for
`/admin/*` is enforced at the API boundary, not in SQL.

## Layout

```
packages/contracts/      @yaycay/contracts: openapi.yaml, schemas/, src/ (DTOs)
supabase/migrations/     0001 identity, 0002 app core, 0003 RLS, 0004 admin v0.2
supabase/functions/      Deno edge functions + _shared harness/brevo/http
supabase/tests/          pgTAP RLS isolation + admin-gating tests
docs/                    model context + backend handoff
```

## Develop

```bash
npm install
npm run contracts:validate   # parse OpenAPI + compile the JSON schema
npm run build                # build @yaycay/contracts
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

## Conventions

TypeScript everywhere, Node 20. `develop` -> staging, `main` -> production;
every PR runs the full suite and blocks merge on failure. Conventional commits.
Writing rule for all docs and copy: no em-dashes.
