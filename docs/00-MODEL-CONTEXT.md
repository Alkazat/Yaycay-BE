# Yaycay - Model Context (read this first)

> Shared architecture and contracts for all four build threads. Every thread (FE, BE, Admin, Website) reads this file before starting and treats it as the single source of truth. Where a thread needs something not covered here, it proposes a change to the **shared contract** (see §3), it does not invent a divergent version.

- **Product:** Yaycay - a family holiday companion. One chat builds a whole trip; every child gets a personalised adventure; grown-ups get a calm plan; the family keeps a memory book.
- **Domain:** yaycay.ai
- **Tagline (never reword):** *For families making memories.*
- **Org / repos:**

| Thread | Repo | Role |
|---|---|---|
| Front-end | `github.com/Alkazat/Yaycay-FE` | Customer PWA (planning + holidaying) |
| Back-end | `github.com/Alkazat/Yaycay-BE` | API, data, AI harness, MCP, payments. **Owns the contract.** |
| Admin | `github.com/Alkazat/Yaycay-Admin` | Internal ops, prompt/model management, troubleshooting |
| Website | `github.com/Alkazat/Yaycay-Website` | Marketing funnel, free-demo capture |

---

## 1. Product in one page

- **Free demo (the hook):** a countdown timer + one AI-built day, for one person, with one quiz and a teaser of the grown-ups guide. Captures an account + email (synced to Brevo). The "one AI action" is never advertised; it is just how the demo generates.
- **Paid holiday, two ways to buy (one-off):**
  - **BYO-AI - US$59:** the parent connects their own ChatGPT / Claude / Gemini via a secure MCP connector. Ongoing AI cost to us ≈ $0.
  - **Use-our-AI - US$129:** we run a guardrailed chat on Claude **Sonnet**. No AI subscription needed.
- **Two modes:**
  - **Planning** (parent + an AI: their own via MCP, or ours): builds and edits the trip through conversation - reservation import, photo import, journey optimisation, group/family balancing.
  - **Holidaying** (the family, in-app): kid explorer modes, quizzes, map, journal, photo capture, offline.
- **Value ladder:** Free demo → paid holiday (anchor $129, $59 accessible entry) → keep-data (~$9/yr) → refer-a-friend (discount, near-$0 CAC) → next holiday pre-filled.
- **Margins:** ~94% BYO-AI, ~91% use-our-AI. First ~10 accounts run on free infrastructure ($0).

---

## 2. The four systems and how they fit

```
                         ┌──────────────────────────┐
  Website (funnel) ─────▶│  Free demo signup + email │──▶ Brevo
                         └─────────────┬────────────┘
                                       ▼
            ┌──────────────────────────────────────────────┐
   FE (PWA) │  Planning (chat: ours/BYO)  +  Holidaying     │
            └───────────────┬──────────────────────────────┘
                            │  @alkazat/contracts (types + OpenAPI)
                            ▼
            ┌──────────────────────────────────────────────┐
   BE       │ API · AI harness · MCP · Stripe · webhooks    │
            └───────────────┬──────────────────────────────┘
                            ▼
            Supabase: Postgres (RLS) · Auth (isolated) · Storage
                            ▲
   Admin ───────────────────┘  (admin-scoped API, off-domain, MFA)
```

- **BE is the hub and the contract owner.** FE, Admin and Website are clients.
- Each system is **independently deployable** behind a stable contract. A change to the contract is a deliberate, versioned event (§3), not an ad-hoc edit.

---

## 3. The shared contract (the handshake)

The contract is a published package, **`@alkazat/contracts`**, generated and owned by BE and consumed by FE, Admin and Website. (The scope is `@alkazat` - it must match the GitHub org that owns the package; an earlier `@yaycay/contracts` name was never published.) It ships to GitHub Packages: consumers add `@alkazat:registry=https://npm.pkg.github.com` to `.npmrc` and authenticate with a `read:packages` token. The authoritative record of what is published, reconciled, or deferred lives in `Yaycay-BE/docs/CONTRACT-STATUS.md` - read it alongside this section.

It contains:
- **OpenAPI 3.1 spec** for the HTTP API (`openapi.yaml`).
- **TypeScript types** generated from the schema (`dist/index.d.ts`) - request/response DTOs, the `TripContent` model, enums.
- **JSON Schemas** for the canonical content model (`schemas/trip-content.schema.json`) and the MCP tool inputs.
- **Semantic version.** Clients pin a version (current: `^0.8.0`). Breaking changes bump major.

**Change protocol (how threads stay in sync):**
1. A thread that needs a new/changed endpoint or field opens a PR against the **contract** in `Yaycay-BE` describing the change.
2. BE implements it, bumps the contract version, publishes (GitHub Packages or a tagged release).
3. Consuming threads bump their pinned version and adapt. (Intended guardrail: a consumer's CI fails if it uses a field not in its pinned contract. This is **not yet wired** - no consumer installs the package today; each keeps a local stub typed to match the published version. Until the package is adopted and the check added, drift is caught only by review, so consumers MUST re-sync their stub on every contract bump.)

**Golden rule:** FE / Admin / Website never call an endpoint or read a field that is not in the contract. BE never ships a breaking change without a major bump.

---

## 4. Canonical data model

PostgreSQL on Supabase. **Identity (accounts/auth) lives in its own isolated store** (a dedicated Supabase project or a locked-down `identity` schema with its own stricter policies); everything else lives in the app database and joins by `user_id` only.

| Table | Holds | Notes |
|---|---|---|
| `accounts` | Parent account (owner) | Identity store. Recovery email, 2FA, role (`user`/`admin`) |
| `child_profiles` | Children under an account | name/avatar, age, interests, dietary/medical flags |
| `trips` | One row per holiday | owner, destination, dates, `tier` (`free`/`byo`/`ours`), status, `retention_expires_at` |
| `trip_content` | The trip payload (one per trip) | JSON: days → moments → activities (see §5) |
| `trip_progress` | Per-profile state | tagged by `profile_id`: done items, active mode |
| `journal_entries` | Notes + star ratings | per profile/day; references media |
| `media` | Print-grade photos | tagged by child; parent-visible; paid only |
| `ai_jobs` | Chat / ingestion / generation jobs | model + prompt version used; enforces the daily cap |
| `connectors` | BYO-AI (MCP) + later social | per account; authenticated; revocable |
| `prompts` | Versioned prompt harness | model-agnostic; edited from Admin |
| `products` / `purchases` | Catalogue + entitlement | from Stripe webhook; tier-aware |
| `marketing_contacts` | Sync to Brevo | consent state; every signup |

**Row-Level Security is mandatory on every table that holds customer data:** a row is readable/writable only by its owning account, except for the `admin` role. RLS is tested (pgTAP) - proving account A can never read account B.

---

## 5. The content model: Holiday → Days → Moments → Activities

One shared `trip_content` JSON per trip. Per-child / per-adult differences are **tagging, not duplication**: per-profile state lives in `trip_progress`/`journal_entries` keyed by `profile_id`, and mode/age variants live as tagged blocks inside the one JSON, selected at render.

```jsonc
{
  "trip":   { "id": "t_123", "destination": "Singapore", "start_date": "2026-06-26",
              "end_date": "2026-07-07", "timezone": "Asia/Singapore", "currency": "SGD" },
  "days": [
    {
      "id": "d_1", "date": "2026-06-26", "label": "Arrival", "summary": "…",
      "moments": [
        {
          "id": "m_1", "slot": "afternoon", "title": "Sentosa beaches",
          "time_hint": "15:00", "location": { "name": "Siloso Beach", "lat": 1.255, "lng": 103.81 },
          "activities": [
            {
              "id": "a_1", "kind": "kid",            // kid | shared | adult
              "title": "Beach treasure hunt",
              "body": "…",
              "variants": {                          // mode/age-tagged; renderer picks by active profile
                "little":        { "body": "simpler, read-aloud copy" },
                "explorer_plus": { "fact": "…", "quiz": { "q": "…", "a": "…" } }
              },
              "media_ref": []
            },
            {
              "id": "a_2", "kind": "adult",
              "title": "Sunset drinks", "booking": { "name": "Ola Beach Club", "time": "18:30" },
              "safety": { "note": "Lenny: anaphylactic, nuts/legumes - confirm with kitchen" }
            }
          ]
        }
      ]
    }
  ],
  "grownups": { "essentials": "…", "checklist": [], "transport": "…" }
}
```

- **`kind`** routes an activity to the kid view, the shared view, or the grown-ups view.
- **`variants`** is how one activity renders differently per child mode/age.
- **`safety`** carries dietary/medical flags surfaced to adults.
- FE renders this; BE + the AI harness produce and mutate it. The schema is owned in the contract (`schemas/trip-content.schema.json`); validate against it on write.

---

## 6. Auth model

- **Supabase Auth.** Email magic-link **plus a one-time 2FA code on every sign-in**. Password reset requires a **secondary email**.
- **Identity is isolated** from trip data (§4). Sessions are standard Supabase JWTs; the DB reads the JWT to enforce RLS.
- **Roles:** `user` (locked to own rows) and `admin` (Admin app + broad access). MFA is mandatory for `admin`.
- **Social media is a connector, not a login.** Authentication is always Yaycay's own.

---

## 7. AI harness + the BYO-AI MCP contract

- **Model-agnostic harness** in BE speaks to Claude / Gemini / OpenAI; the model per task is chosen in Admin and stored with the prompt version. **Default for the use-our-AI tier is Claude Sonnet.**
- **Two planning paths, one backend:**
  - **Use-our-AI ($129):** FE calls BE chat endpoints; BE runs the guardrailed Sonnet conversation and mutates `trip_content`.
  - **BYO-AI ($59):** BE exposes an authenticated **MCP endpoint**; the parent's own agent calls tools to read/update the trip. Ongoing inference is on the customer's model.
- **Jobs are bounded:** ingestion (receipt/photo/booking → itinerary update) is capped at **~10 AI updates/day** per trip; beyond that, updates **queue** for the next day or are entered manually. Every job is logged in `ai_jobs`.
- **MCP tool surface (illustrative; defined in the contract):** `get_trip`, `list_days`, `add_activity`, `update_activity`, `move_activity`, `add_moment`, `import_reservation(text|image)`, `set_packing_list`, `optimise_day(day_id)`. All scoped to the authenticated account + trip.

---

## 8. Payments (Stripe)

- **Stripe Checkout, one-off.** Entitlement set by webhook → `purchases`. No subscription on the core product; the only recurring item is the data-keep token.
- **Catalogue (example price IDs):** `price_holiday_byo` ($59), `price_holiday_ai` ($129), `price_datakeep_annual` ($9/yr), `price_destination_addon` ($49), `price_explorerplus` ($12), `price_photobook` (from $39), `price_gift`.
- Card data never touches our systems. Webhook handler lives in BE; FE/Website only open Checkout sessions created by BE.

---

## 9. Marketing capture (Brevo)

- Every signup (free or paid) becomes a `marketing_contacts` row and syncs to **Brevo** with consent state.
- Brevo bills by sends, not contacts, so unlimited free signups cost nothing to hold.
- Transactional emails (2FA codes, magic links) go through a transactional sender, separate from marketing.

---

## 10. The design system (shared, mandatory)

All four threads use the **Yaycay design system** (supplied separately as `Yaycay Design System`). Do not re-implement styles.

- **Entry point:** link `styles.css` (pulls tokens, the Fredoka + Nunito webfonts, and base styles).
- **Fonts:** Fredoka (display/headings), Nunito (body/UI).
- **Palette (semantic tokens):** `--brand-primary` sky `#2A96D8`, `--brand-primary-deep` royal `#0A4C8B`, `--brand-cta` sun `#F7AA15`, `--brand-accent` aqua `#2BC3D0`, success meadow `#46B25E`, alert coral `#FF6F4D`, surfaces cream `#FBF7EC`, ink `#1C2733`, muted sand `#6F695D`.
- **Components:** Button, IconButton, Card, Stat, Badge, Tag, Tabs, Banner, Input, Select, Checkbox, Switch, ProgressMeter, Avatar. Compose from these.
- **UI kits to copy from:** `ui_kits/app` (product) and `ui_kits/web` (marketing). Ad + email specimens exist for the Website/launch creative.
- **Look:** early-2000s "game box-art" - chunky, outlined, glossy, warm, sunny. **Tagline fixed.**

---

## 11. Environments, CI/CD and conventions

- **Language:** TypeScript everywhere. Node 20.
- **Branches:** `develop` → staging, `main` → production. Every PR runs the full test suite and blocks merge on failure; every deploy runs a **smoke test**.
- **Hosting:** Vercel (FE, Admin, Website); Supabase Edge Functions (BE). Production domains on `*.yaycay.ai`; staging on `staging.*`. Admin is **off-domain** (its own domain), MFA-gated.
- **Two Supabase environments** (staging + prod); migrations via the Supabase CLI; a dedicated identity project/schema.
- **Testing baseline (all threads):** Vitest (unit), Playwright (E2E at phone/tablet/desktop viewports), and the **touch hard-rules** (no nested scroll traps / "double-scroll", min tap targets, no hover-only controls, iOS safe-areas). BE adds pgTAP for RLS.
- **Commit/lint:** shared ESLint/Prettier config; conventional commits.
- **Writing rule for all docs and copy:** no em-dashes; use hyphens, commas, or rewrite.

---

## 12. Security & privacy (build requirement, not policy)

- RLS isolates every family at the database. Private media via short-lived signed URLs only.
- Australian Privacy Principles **in the code**: data minimisation, purpose limitation, access control in schema + API.
- **Disposal by default, retention as the premium:** trip data is scheduled for deletion 12 months post-holiday unless a keep-token is bought.
- Children's data is owned/controlled by the parent account and minimised.
- In transit TLS 1.3 + hybrid post-quantum (ML-KEM via Cloudflare); at rest AES-256; iOS uses CryptoKit (corecrypto-backed). Secrets server-side only.

---

## 13. Build sequence across threads

1. **BE first** publishes contract `v0.1` (auth, `trips`, `trip_content`, demo-generate, signup/capture) so others can mock against it.
2. **Website** and **FE demo** build against `v0.1` in parallel (Website needs only signup/capture; FE needs demo-generate + render).
3. **BE** adds paid flows (Stripe, chat, ingest, MCP) → contract `v0.2`; **FE** builds Planning + Holidaying.
4. **Admin** builds against the admin-scoped contract once prompts/jobs exist.
5. Each thread keeps its own `develop`/`main` pipeline green and smoke-tested throughout.

> When in doubt, prefer the smallest contract change that unblocks you, and raise it as a PR on `Yaycay-BE`. Keep the family experience and the brand at the centre of every decision.
