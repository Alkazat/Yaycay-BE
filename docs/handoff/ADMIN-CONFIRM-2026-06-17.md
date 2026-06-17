# Handoff → Yaycay-Admin: confirmation of open items

**From:** Yaycay-BE. **Date:** 2026-06-17.
**Contract to pin:** `@alkazat/contracts@^0.28.0` (published). Drop any local DTO stand-ins.

This closes out every open question from the Admin thread. All items below are **deployed to production** with green CI unless explicitly marked as an ops action.

---

## 1. Affiliate edit + archive — ✅ DONE (was the main gap)

Both endpoints now exist, contract published in **0.28.0**.

| Method + path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `PUT /admin/affiliates/{code}` | `UpdateAffiliateInput` | `Affiliate` | Edit `name`/`email`/`handle`/`commissionPercent`/`landingSlug` (partial — only provided fields change). |
| `DELETE /admin/affiliates/{code}` | — | `Affiliate` | Archive (soft-delete): stamps `archivedAt`, sets `status=paused`, deactivates the Stripe promo so it stops redeeming. Idempotent. |

- **`discountPercent` and `code` are immutable** after creation (the Stripe coupon `percent_off` and promotion `code` cannot be changed in Stripe). A change attempt returns `422` — archive and recreate to change them.
- `GET /admin/affiliates` **hides archived by default**; pass `?includeArchived=true` to include them.
- `Affiliate` now carries `archivedAt: string | null`.
- Status changes on an archived affiliate return `409`.
- Your Edit/Archive buttons can go live now.

The rest of the affiliate program was already live (create, list, detail, pause/reactivate, redemptions, monthly Brevo report) — and create was hardened earlier this session (clear `502` on Stripe errors + idempotent retry), now running on a dedicated restricted key (`STRIPE_COUPON_KEY`).

---

## 2. Connectors — ✅ deployed

- `GET /admin/connectors` and `POST /admin/connectors/{id}/revoke` are live. Revoke stamps `revoked_at`, clears issued-token hashes (kill-switch — next MCP call fails verification).
- **BYO/connector writes are logged + reviewed:** every MCP write goes through `mutate()`, which writes an `ai_jobs` row (`startJob`/`finishJob`, `kind=ingestion`, `source=connector`) and upserts `content_review` to `pending`. So connector-driven trip content is logged to `ai_jobs` and routed through Content Review.

---

## 3. Audit sink — ✅ durable

`public.admin_audit_log` (DB table, migration 0004) is the canonical sink. `writeAudit` records every `/admin/*` write (actor, action, target, before/after) — including `affiliate.create/update/status/archive/report-send` and `connector.revoke`. Reads are access-logged too.

---

## 4. /admin/products — ✅ live-mode scoped

Filtered `.eq('livemode', stripeLivemode())` (live on prod, test on staging) and the `livemode` flag is returned on each product.

---

## 5. /admin/jobs — ✅ 200

Queries `ai_jobs` via the service role (bypasses RLS), `select('*')` so no column coupling. No 500 path remains. Supports `?status=&kind=&tripId=` filters + cursor pagination; `getJob`, `retryJob`, and the daily-cap endpoint are wired.

---

## 6. Checkout 422 (paid purchases) — ✅ FIXED (Option A) + 1 ops confirm

**Fixed:** `POST /checkout/session` now accepts the contract **ProductId catalogue key** (e.g. `price_holiday_ai`) in **either** `product_id` *or* `price_id`, and resolves it to this environment's live Stripe price via `product_catalogue`. A real Stripe price id in `price_id` still works as a literal. **No FE change required.**

**⚠️ Ops must confirm (data, not code):** for each live product the prod DB needs both:
1. `product_catalogue.stripe_price_id` set to the live price, and
2. a matching row in `public.products` (`price_id`, `tier`, `kind`, `active=true`, `livemode=true`).

If either is missing, checkout returns a clear `400 "Product is not available"` / `"No such purchasable product"` (not the old opaque 422).

**Verify in the Supabase SQL editor** ([supabase.com/dashboard/project/_/sql/new](https://supabase.com/dashboard/project/_/sql/new)):

```sql
select c.product_id, c.stripe_price_id,
       p.price_id as in_products, p.tier, p.kind, p.active, p.livemode
from public.product_catalogue c
left join public.products p
  on p.price_id = c.stripe_price_id and p.livemode = true
where c.product_id in ('price_holiday_ai','price_holiday_byo','price_datakeep_annual');
```
Every row should have a non-null `stripe_price_id` **and** a non-null `in_products` with `active=true`. Get live price ids from [dashboard.stripe.com/prices](https://dashboard.stripe.com/prices) (Live mode). Webhook entitlement is already wired for live mode.

---

## Definition of done — status

- [x] Affiliate list / create / detail / pause / **edit** / **archive** / redemptions / report
- [x] Connectors list + revoke; BYO writes → `ai_jobs` + Content Review
- [x] Durable audit sink for `/admin/*`
- [x] `/admin/products` live-mode scoped (+ `livemode`)
- [x] `/admin/jobs` returns 200
- [x] Checkout accepts catalogue keys (paid purchases unblocked)
- [ ] **Ops:** confirm the three live prices in `product_catalogue` + `public.products` (SQL above)

**Action for Admin:** pin `@alkazat/contracts@^0.28.0`, drop local affiliate DTO stand-ins, ship the Edit/Archive buttons. Reply if any endpoint shape doesn't match.
