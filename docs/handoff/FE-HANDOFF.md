# FE handoff — confirm / develop

**Contract:** `@alkazat/contracts@^0.13.0` (GitHub Packages). Source of truth is
`packages/contracts/openapi.yaml`; this is the action list.

```
# .npmrc (scope) + ~/.npmrc (auth, keep token out of committed files)
@alkazat:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<token with read:packages>
```

**Base URL** (no gateway — paths are the function names):
```
NEXT_PUBLIC_API_BASE = https://<project-ref>.supabase.co/functions/v1
# prod ref: nzmjkbjtcjthjwdscjrj   staging ref: srpipqrxggmfeagomvnk
NEXT_PUBLIC_SUPABASE_URL = https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY = <that project's anon key, Settings -> API>
```
Headers: every request sends `apikey: <anon key>`; authenticated routes also
`Authorization: Bearer <user JWT>`. Hyphenated path exceptions:
`/demo/generate-day → /demo-generate-day`, `/signup/capture → /signup-capture`,
`/auth/2fa/verify → /auth-2fa-verify`. Everything else matches.

---

## CONFIRM — live in prod; pin `^0.13.0`, flip `SERVED`, swap mock → contract types

| Endpoint | Type | Note |
|---|---|---|
| `POST /demo/generate-day` | `DemoGenerateDayResponse` | real, rich AI (facts, typed challenge, per-mode variants, did_you_know, safety) |
| `POST /signup/capture` | `SignupCaptureResponse` | + Brevo sync |
| `POST /auth/2fa/verify` | `TwoFactorVerifyResponse` | elevates session to AAL2 |
| `GET/POST /trips`, `GET /trips/:id`, `GET/PATCH /trips/:id/content` | `TripSummary` / `Trip` / `TripContent` | RLS-scoped to the caller |
| `POST /trips/:id/plan/chat` | SSE `PlanChatEvent` | tier=ours |
| `POST /trips/:id/ingest` | `IngestResponse` | paid (byo/ours) |
| `GET/POST /profiles`, `PATCH/DELETE /profiles/:id` | `ChildProfile` | mode enum incl. `standard` |
| `GET/PATCH /trips/:id/progress` | `TripProgress` | done items + active mode |
| `GET/POST /trips/:id/journal` | `JournalEntry` | now incl. `mood` + 1-5 `stars` (POST paid) |
| `POST /media/sign-upload` | `SignUploadResponse` | signed Storage URL (paid) |
| `GET/PATCH /trips/:id/packing` | `PackingResponse` `{ lists }` | single collection PATCH (`tick`/`add`/`delete`/`reset`); every call returns the whole `{ lists }` |
| `GET /trips/:id/stars`, `POST /trips/:id/stars/claim` | `StarsResponse` / `StarClaimResponse` | claim idempotent per child/day/source |
| `GET/PATCH /trips/:id/grownups/checklist` | `ChecklistResponse` | persisted ticks (single or batch) |
| `POST /checkout/session` | `CheckoutSessionResponse` | Stripe Checkout URL |
| `POST /connectors/byo-ai`, `GET /connectors`, `POST /mcp` | BYO-AI MCP | tier=byo |

Each is a one-line `SERVED` flip in `lib/api/http.ts` + a type swap.

---

## DEVELOP — still pending

- **(BE dependency) Real customer sign-in needs prod auth config.** `/trips` etc.
  require a valid session; the prod Supabase project still needs its **email
  provider + Site URL/Redirect URLs** set (see BE `docs/P1-AUTH-CHECKLIST.md`).
  Until then signed-in calls 401. Endpoints + RLS are done.
- **Mode enum rename:** the contract uses `little|standard|explorer|explorer_plus`
  (`standard` included) — align any local `mode` usage on wiring.
- **Packing:** BE seeds the list/section skeleton on first `GET` (a `family` list
  + one per child profile). Use the `section_id`s from `GET` in `add` — don't
  hard-code them.
