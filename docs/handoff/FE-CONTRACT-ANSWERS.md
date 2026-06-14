# BE answers: FE contract 0.18 adoption

**From:** Yaycay-BE. **Date:** 2026-06-14.
**Re:** your `09CONTRACT018FEQUESTIONS.md`.

All three surfaces are **live on prod**. (Contract is now at **0.22.0** — all
additive, so your 0.18 questions hold; pin `^0.22.0` to also get the connector +
chat/companion types.) Base: `https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1`.

---

## 1. Account — both live ✅

- **`GET /account`** — deployed, serves `AccountSummary`:
  `{ email, secondary_email, tier, role, two_factor_enrolled, deletion_requested_at, created_at }`.
  `tier` is derived from purchases (highest of free/byo/ours).
- **`PATCH /account`** — deployed, accepts `AccountUpdate`
  `{ secondary_email?: string | null }`; `null` or `""` clears it; validates the
  email; returns the updated `AccountSummary`.
- **Auth:** yes — `Authorization: Bearer <parent JWT>` + `apikey: <anon>`,
  `verify_jwt=true`, same as the trips endpoints.
- **Live path:** `…/functions/v1/account` (its own function; first path segment).
- **Bonus (v0.19):** `POST` / `DELETE /account/deletion-request` are live for a
  "request/cancel account deletion" action.

→ Flip `SERVED.account = true`, wire the recovery-email editor. Both GET+PATCH
are live, so no read-only phase needed.

## 2. Media — live, mind the function name ✅

- **Deployed** as the Edge Function **`media-sign-upload`** (renamed to match
  your hyphenated `livePath` convention). Live path:
  `…/functions/v1/media-sign-upload` → pass `livePath: "/media-sign-upload"`.
- **Request:** `POST { trip_id: string, content_type?: string }`.
  **Response:** `{ media_ref, path, upload_url, token }`.
- **Entitlement:** owner of a **paid** trip (byo|ours) only → else
  `403 entitlement_required`; `404` if the trip isn't visible.
- **Bucket:** `trip-media` (private). Client `PUT`s the bytes to `upload_url`.
- **Limits:** none enforced server-side yet — enforce client-side (suggest
  `image/jpeg|png|webp|heic`, ≤ ~10 MB). Ask if you want a hard server cap.
- **Read side:** journal `media_ref`s resolve to signed URLs on
  `GET /trips/:id/journal`, so photos display.

→ Flip `SERVED.media = true`.

## 3. Checkout affiliate `code` — honoured ✅

- The live `POST /checkout/session` **applies** a valid `code`: resolves the
  affiliate's active Stripe promotion code, attaches the discount to the session,
  and records attribution (`discount_code` / `discount_usd` / `gross_usd` on the
  purchase via the webhook).
- **Invalid / expired / unknown code:** silently **ignored** — the session is
  still created at full price, no error.
- **What the FE should do:** **pass it through; no client-side validation.**
- **Capture path:** BE is agnostic — it only consumes
  `CheckoutSessionRequest.code`. The `/go/<slug>` funnel lives in the Website;
  you capture (`?code=` or cookie) and forward the string. BE reads neither
  cookies nor query for this.

---

## Connector hardening — done (separate from 0.18)

Shipped in contract **0.22.0**: durable shared `oauth_grants` store, admin
`GET/POST /admin/connectors[/{id}/revoke]`, `ai_jobs.source='connector'` +
content-review routing, and the `plan_trip` write path honours
`x-yaycay-source: connector`. Your MCP server still needs to write grants into
`oauth_grants`, honour `status`/`token_version` in `verifyMcpToken`, stamp
`last_used_at`, and forward `x-yaycay-source`/`-connector-id`/`-assistant` on
writes. Full spec: `docs/handoff/BACKEND-STORES.md` (§B).

---

## Quick reference

| Endpoint | Status | FE action |
| --- | --- | --- |
| `GET /account` | live | flip `SERVED.account` |
| `PATCH /account` | live | recovery-email editor |
| `POST /media/sign-upload` (fn `media-sign-upload`) | live | flip `SERVED.media`, `livePath: /media-sign-upload` |
| `code` on `POST /checkout/session` | live, honoured | capture `/go/<slug>` or `?code=`, forward |
