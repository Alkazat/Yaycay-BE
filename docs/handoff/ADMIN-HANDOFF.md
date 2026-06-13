# Admin handoff — confirm / develop

**Contract:** `@alkazat/contracts@^0.13.0` (GitHub Packages; same `.npmrc` setup
as FE). **Base URL:** `https://<project-ref>.supabase.co/functions/v1` — admin
paths match the contract (`/admin/*`). Headers: `apikey: <anon key>` +
`Authorization: Bearer <admin JWT>`.

**Auth model:** the gateway verifies the JWT; the handler requires **AAL2**
(verified MFA) **and** `role=admin` resolved server-side from the isolated
`identity.accounts` store (not a JWT claim). Errors are RFC 9457 problem+json;
500s now carry the cause in `detail`.

---

## CONFIRM — live in prod; pin `^0.13.0`

| Endpoint | Returns |
|---|---|
| `GET /admin/me` | `AdminSession` (role + MFA) |
| `GET /admin/jobs`, `/admin/jobs/cap`, `GET /admin/jobs/:id`, `POST /admin/jobs/:id/retry` | `AiJob` / `JobCapUsage` |
| `GET /admin/prompts` (+ `:id`, `/versions`, `/activate`, `/diff`) | `Prompt` (versioned) |
| `GET /admin/models`, `GET/PUT /admin/model-routes` | `AiModel` / `ModelRoute` |
| `GET /admin/trips` (+ `/:id`, `/content`, `/profiles`, `/progress`) | `AdminTripSummary` / content / `TripProgress` |
| `GET /admin/customers`, `POST /admin/customers/:id/deletion-request` | `CustomerSummary` |
| `GET /admin/content-review` (+ `/approve`, `/edit`) | `ContentReviewItem` |
| `GET/POST /admin/products`, `PATCH /admin/products/:priceId` | `ProductSummary` |
| `GET /admin/purchases` | `PurchaseSummary` (paginated) |

**Renames to import (off-domain shapes that collided with customer names):**
- `TripSummary` → **`AdminTripSummary`**
- `ChildProfile` → **`AdminChildProfile`** (the customer `ChildProfile` is the canonical one)

**Commerce notes:**
- `/admin/products` is **scoped to the deployment's Stripe mode** — prod returns
  only live prices, staging only test. Each row carries **`livemode`** (`true`=live,
  `false`=test) for a Test/Live badge.
- `createProduct` stamps the current mode; `kind: 'keep'` + `extendsMonths` defines
  a keep-token (needs a real Stripe price id).

---

## DEVELOP — still pending

- **Admin provisioning:** the founding admin is bootstrapped on deploy. Promoting
  further admins is currently a SQL `update identity.accounts set role='admin'`
  — build a proper admin-management screen if you want it in-app.
- **Staging admin:** optional; create a staging auth user + promote to test admin
  there (prod is already set).
- **Keep-token product:** the machinery is live; no keep-token product row exists
  until a Stripe keep price is created and added via `POST /admin/products`.
