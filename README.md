# Yaycay Back-End

The platform core for Yaycay, the family holiday companion: the HTTP API, the
database and Row-Level Security, the model-agnostic AI harness, the BYO-AI MCP
endpoint, Stripe, and the Brevo sync. Thin, serverless, scales to zero.

**This thread owns the shared contract** (`@yaycay/contracts`). FE, Admin and
Website depend on what we publish, so the contract is the primary deliverable
alongside the code. See [`docs/00-MODEL-CONTEXT.md`](docs/00-MODEL-CONTEXT.md)
(read first) and [`docs/02-BACKEND-HANDOFF.md`](docs/02-BACKEND-HANDOFF.md).

## Status: Phase 0

The free-demo hook, lead capture, the core data model with RLS, and contract
`v0.1` published for the other threads to mock against.

| Area | Delivered |
|---|---|
| Contract | `openapi.yaml` (3.1), generated TS DTOs + `TripContent`, `schemas/trip-content.schema.json`, semver |
| Schema + RLS | `accounts` (isolated identity), `child_profiles`, `trips`, `trip_content`, `trip_progress`, `ai_jobs`, `marketing_contacts`; RLS forced on every customer table; pgTAP isolation test |
| Endpoints | `POST /demo/generate-day` (AI harness + deterministic fallback), `POST /signup/capture` (Brevo sync) |
| CI | contract validation, lint, typecheck, Vitest, Deno typecheck, pgTAP |

Phase 1 (auth, trip CRUD, our-AI chat, ingest + daily cap, journal/media,
Stripe, MCP) and Phase 2 (admin, retention/disposal, catalogue) are not yet
built. See the handoff for the full checklist.

## Layout

```
packages/contracts/      @yaycay/contracts: openapi.yaml, schemas/, src/ (DTOs)
supabase/migrations/     0001 identity, 0002 app core, 0003 RLS
supabase/functions/      Deno edge functions + _shared harness/brevo/http
supabase/tests/          pgTAP RLS isolation tests
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
