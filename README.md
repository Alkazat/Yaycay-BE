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
| Endpoints | `POST /demo/generate-day` (AI harness + deterministic fallback), `POST /signup/capture` (Brevo sync), and the full `/admin/*` surface (one `admin` edge function: prompts, models/routes, jobs, trips/customers, content review, commerce) |
| CI | contract validation, lint, typecheck, Vitest, Deno typecheck, pgTAP |

The `admin` edge function enforces `role=admin` + AAL2 (MFA), audits every call
to `admin_audit_log`, returns RFC 9457 problem+json, and paginates by cursor.
Phase 1 (auth, trip CRUD, our-AI chat, ingest + daily cap, journal/media,
Stripe, MCP) and the rest of Phase 2 (retention/disposal) are still to come. The
AAL2 check reads the JWT `aal` claim; wire real MFA enrolment in Phase 1.

## Layout

```
packages/contracts/      @yaycay/contracts: openapi.yaml, schemas/, src/ (DTOs)
supabase/migrations/     0001 identity, 0002 app core, 0003 RLS, 0004 admin v0.2
supabase/functions/      Deno edge functions (demo, signup, admin) + _shared
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

### Releasing the contract

`@yaycay/contracts` publishes to GitHub Packages from
`.github/workflows/publish-contracts.yml`, triggered by a version tag:

```bash
# bump packages/contracts/package.json (e.g. 0.2.0), merge, then:
git tag contracts-v0.2.0
git push origin contracts-v0.2.0
```

The workflow checks the tag matches `package.json`, validates and builds the
package, and runs `npm publish`. Consumers install with an `.npmrc`:

```
@yaycay:registry=https://npm.pkg.github.com
```

**Scope/owner requirement:** GitHub Packages requires the npm scope to match the
repository owner. `@yaycay/contracts` must therefore be hosted under a `yaycay`
GitHub org. If the repo stays under a different owner, create that org (or change
the package scope to match the owner) before the first publish will succeed.


## Conventions

TypeScript everywhere, Node 20. `develop` -> staging, `main` -> production;
every PR runs the full suite and blocks merge on failure. Conventional commits.
Writing rule for all docs and copy: no em-dashes.
