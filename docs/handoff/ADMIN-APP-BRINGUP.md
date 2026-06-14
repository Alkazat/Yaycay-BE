# Admin App — Bring-Up & BE Handshake

**From:** Back-end (Yaycay-BE)
**To:** Admin app thread
**Date:** 2026-06-14
**Status:** BE is live & verified on prod. Admin app (`yaycay-admin.dwhy.com.au`) is **down** — server-side exception on load.

---

## 0. The blocker right now

Loading `https://yaycay-admin.dwhy.com.au` returns:

```
Application error: a server-side exception has occurred while loading
yaycay-admin.dwhy.com.au (see the server logs for more information).
Digest: 2043219604
```

This is a **Next.js startup crash in the Admin app**, not a BE issue. The BE
endpoints below are deployed, green, and reachable. Almost certainly the Admin
Vercel deployment is **missing its Supabase env vars** (or the BE base URL),
so it throws during SSR.

**Please do, in order:**

1. **Vercel → Admin project → Settings → Environment Variables.** Confirm the
   Supabase + API vars exist for the **Production** environment (see §2).
2. If missing/blank, add them, then **Deployments → newest → ⋯ → Redeploy**
   (env changes need a fresh build).
3. If they were present, open **Deployments → live deployment → Runtime Logs**,
   find the entry with **digest `2043219604`**, and paste the stack/error back
   to this thread — that line names the real cause.

---

## 1. Production facts (everything routes here)

| Thing | Value |
|---|---|
| Supabase project ref | `nzmjkbjtcjthjwdscjrj` |
| Supabase URL | `https://nzmjkbjtcjthjwdscjrj.supabase.co` |
| **Edge function base** (no gateway) | `https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1` |
| Admin API base | `https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1/admin` |
| Contract package | `@alkazat/contracts` (GitHub Packages, `npm.pkg.github.com`) |
| Contract version to pin | `^0.17.0` |

> There is **no** `api.yaycay.ai` gateway. The `servers:` block in the OpenAPI
> spec is aspirational. Call functions directly at `…/functions/v1/<name>`.

---

## 2. Env vars the Admin app needs (set in Vercel, Production)

Exact names depend on the Admin codebase, but it needs at minimum:

```
NEXT_PUBLIC_SUPABASE_URL       = https://nzmjkbjtcjthjwdscjrj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY  = <anon public key>
```

- The **anon key** is non-secret: Supabase Dashboard → **Project Settings →
  API → "anon public"**.
- If the Admin app reads the API base from an env var (e.g.
  `NEXT_PUBLIC_API_BASE_URL`), set it to
  `https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1`.
- **Do NOT** put the `service_role` key in the Admin app. The Admin app must
  call the BE with the **logged-in user's JWT**; the BE enforces admin+MFA
  server-side.

---

## 3. Auth requirements (this is strict — BE enforces it)

Every `/admin/*` endpoint requires the caller's Supabase JWT to be **both**:

1. **`role = admin`** in the identity store, AND
2. **`aal2`** — i.e. the session has completed **MFA (TOTP)**.

A normal logged-in (AAL1, no MFA) session gets **403** on `/admin/*`. So the
Admin app's login flow must:

- Sign the user in (magic-link or password — BE supports both).
- **Enroll a TOTP factor** if none exists (`supabase.auth.mfa.enroll`), show the
  QR, verify it.
- **Step up to AAL2** on each login (`mfa.challenge` + `mfa.verify`) before
  calling `/admin/*`.
- Use `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` to decide whether to
  prompt for the code.

**Founding admin is already bootstrapped:** `dyeates@dwhy.com.au` is set to
`role = admin` in prod. It just needs to be able to log in + enroll/step-up MFA
through the Admin app. (If login still 403s after MFA, ping BE — but the role is
set.)

### Supabase Auth dashboard config (P1 — may still be pending)

For Admin login to work at all, prod Auth must have, under
**Authentication → URL Configuration**:

- **Site URL / Redirect URLs** include `https://yaycay-admin.dwhy.com.au`
  (and any `/auth/callback` route the app uses).

And under **Authentication → Providers / MFA**, the email provider + TOTP MFA
must be enabled. **Please confirm whether this is set** — if not, that's a
second blocker BE/owner needs to clear (it's owner-side dashboard config, not
code).

---

## 4. Admin endpoints available (contract v0.17.0)

All under `…/functions/v1/admin`, all require admin+AAL2, all audited.

| Method & path | Purpose |
|---|---|
| `GET /admin/me` | Resolve the caller's admin identity (use to gate the dashboard instead of probing a 403). |
| `GET /admin/prompts`, `…/models` | AI prompt + model-route config. |
| `GET /admin/jobs` | Generation jobs. |
| `GET /admin/trips`, `GET /admin/customers` | Trip & customer browsing. |
| `GET /admin/content-review` | Content review queue. |
| `GET/POST /admin/products` | Stripe catalogue (scoped to the deployment's Stripe mode; each product has `livemode`). |
| `GET /admin/admins`, `POST /admin/admins` | Admin management (promote/demote by email). |
| **Affiliate program** ↓ | |
| `GET /admin/affiliates` | List affiliates (paginated). |
| `POST /admin/affiliates` | Create affiliate → also creates the Stripe coupon + promotion code. Body: `{ name, email, handle, discountPercent, commissionPercent, code?, landingSlug? }`. |
| `GET /admin/affiliates/:code` | Get one. |
| `PATCH /admin/affiliates/:code/status` | `{ status: "active" \| "paused" }` (toggles the Stripe promo). |
| `GET /admin/affiliates/:code/redemptions` | Attributed purchases (paginated). |
| `POST /admin/affiliates/:code/report` | `{ periodStart, periodEnd }` → emails the commission report via Brevo. |
| **Data deletion console** ↓ | |
| `GET /admin/deletion-requests` | Queue: accounts with a deletion request, oldest first, each with footprint (`tier`, `trips`, `media`, `purchases`), `ageDays`, `eligibleAt`, `eligible`. |
| `GET /admin/deletion-requests/:userId` | Verify one request's footprint before acting. |
| `POST /admin/deletion-requests/:userId/cancel` | Clear the request. |
| `POST /admin/deletion-requests/:userId/execute` | Hard delete (irreversible). Body `{ email, force? }`: `email` must match the account (confirm-by-typing); blocked inside the 30-day grace window unless `force: true`. `409` if within grace, `422` on email mismatch. |

Full request/response shapes are in `@alkazat/contracts@0.20.0`
(`openapi.yaml` + the generated DTOs: `Affiliate`, `CreateAffiliateInput`,
`AffiliatePage`, `AffiliateRedemptionPage`, `AffiliateReportRequest`,
`AdminAccount`, `ProductSummary`, `DeletionRequest`, `DeletionRequestPage`,
`ExecuteDeletionRequest`, `DeletionResult`, `CancelDeletionResult`, etc.).

> Consumer surfaces also shipped since this doc was written: `GET/PATCH /account`
> (+ `POST/DELETE /account/deletion-request`) and the `media-sign-upload`
> function. Those are FE-facing, not admin.

---

## 5. Error format

All `/admin/*` errors are RFC 9457 problem+json:

```json
{ "type": "about:blank", "title": "Forbidden", "status": 403,
  "detail": "Multi-factor authentication (AAL2) is required for admin access." }
```

Common ones to handle in the UI:
- `403 "…AAL2 is required…"` → step up MFA, retry.
- `403 "Admin role required."` → the account isn't an admin.
- `401` → no/expired token; re-auth.

---

## 6. What BE needs back from you (to unblock fast)

Please reply on the thread with:

1. **The Runtime Log line** for digest `2043219604` (the actual crash cause).
2. **The Admin project's current env var names** (values not needed — just the
   names, so we can confirm the Supabase ones are present).
3. **Which login method** the Admin app uses (magic-link vs password) and
   whether it has an **MFA enroll + step-up** flow implemented.
4. Confirmation of whether **Auth → URL Configuration** has
   `https://yaycay-admin.dwhy.com.au` in Site/Redirect URLs (§3).

With #1–#4 we can pinpoint whether the fix is env vars (you), dashboard auth
config (owner), or app code (Admin repo).

---

## 7. TL;DR

- BE is done and live; `/admin/*` (incl. affiliates) works once a valid
  **admin + MFA** JWT hits it.
- The Admin app is crashing on load — **check/set Supabase env vars in Vercel
  and redeploy** first; if still broken, send the runtime-log line for digest
  `2043219604`.
- Founding admin `dyeates@dwhy.com.au` is already `role=admin`; it just needs a
  working login + MFA flow in the Admin app.
