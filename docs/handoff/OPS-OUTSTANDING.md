# Yaycay — Outstanding non-coding items (ops runbook)

Everything in the contract/BE is built, deployed, and published
(`@alkazat/contracts@0.15.0`). The items below are **dashboard / Stripe / config**
actions only you can do — no code. Prod project ref **`nzmjkbjtcjthjwdscjrj`**,
staging **`srpipqrxggmfeagomvnk`**.

---

## 1. Customer auth config (REQUIRED — gates real sign-in)

Without this, `/trips`, `/profiles`, etc. return 401 because no real session can
be minted. All in the **prod** Supabase dashboard.

### 1a. Redirect / Site URLs
→ **https://supabase.com/dashboard/project/nzmjkbjtcjthjwdscjrj/auth/url-configuration**
1. **Site URL** = your deployed FE origin (e.g. `https://app.yaycay.ai` or the Vercel prod URL).
2. **Redirect URLs** → *Add URL* for each:
   - `https://<your FE prod origin>/**`
   - `http://localhost:3000/**`
   - `https://*.vercel.app/**` (if you use preview deploys)
3. **Save changes**.

### 1b. Email provider
→ **https://supabase.com/dashboard/project/nzmjkbjtcjthjwdscjrj/auth/providers**
1. Open **Email** → confirm **Enable Email provider** is on (default).
2. Leave magic-link / OTP defaults. **Save**.

### 1c. MFA (TOTP)
→ same Providers page → **Multi-Factor Authentication** → enable **Authenticator app (TOTP)** → **Save**.
(Needed for admin AAL2; harmless for customers.)

### 1d. (Optional) real email sending
→ **https://supabase.com/dashboard/project/nzmjkbjtcjthjwdscjrj/auth/templates** → **SMTP Settings** →
enter your Brevo SMTP (host/port/user/pass + sender) → **Save**.
The built-in sender works at low volume for testing; custom SMTP is for production volume.

### 1e. Verify
1. Sign in on the FE; copy the access token (devtools → Application → Local Storage → the supabase auth token).
2. Anon key: **https://supabase.com/dashboard/project/nzmjkbjtcjthjwdscjrj/settings/api**
3. Run:
```bash
BASE=https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1
curl -s -H "apikey: <anon key>" -H "Authorization: Bearer <token>" "$BASE/trips"
# expect 200 + {"trips":[...]}
```
✅ when that returns 200 for a real user.

> Repeat 1a–1c on **staging** (`…/project/srpipqrxggmfeagomvnk/auth/...`) if you want sign-in there too.

---

## 2. Keep-token product (OPTIONAL — only if you sell the data-keep upsell)

### 2a. Create the price in Stripe (LIVE mode)
→ **https://dashboard.stripe.com/products** → toggle **top-right to “Live”** → **+ Add product**
- Name e.g. `Keep our memories`; Pricing **One-off**; set the amount.
- Save → open the price → **copy the price id** (`price_…`).

### 2b. Add it to the catalogue — pick one
- **Hand it to BE:** send me the **price id + name + amount** and I'll seed it (`kind:'keep'`, `extends_months:12`, `livemode` auto-stamped) in one migration.
- **Or self-serve via the admin API:**
```bash
curl -s -X POST \
  -H "apikey: <prod anon key>" -H "Authorization: Bearer <admin JWT>" \
  -H "content-type: application/json" \
  -d '{"priceId":"price_XXX","name":"Keep our memories","amountUsd":9,"kind":"keep","extendsMonths":12}' \
  https://nzmjkbjtcjthjwdscjrj.supabase.co/functions/v1/admin/products
```
### 2c. Verify
`GET …/functions/v1/admin/products` → the keep-token appears with `kind:"keep"`, `livemode:true`.

---

## 3. Optional / later (no action needed now)

- **`DISPOSAL_SECRET`** — only if you want the HTTP `/disposal` trigger. The in-DB
  `pg_cron` sweep already runs nightly, so **skip**. (To add later: create a repo
  secret `DISPOSAL_SECRET`, re-run Deploy, point a scheduler at
  `…/functions/v1/disposal` with header `x-disposal-secret`.)
- **Confirm `pg_cron` is enabled** before your first cohort nears its 12-month
  retention: **https://supabase.com/dashboard/project/nzmjkbjtcjthjwdscjrj/database/extensions**
  → search `pg_cron` → ensure enabled. (Not urgent — nothing is near expiry.)
- **Staging admin user** — optional; create one in
  **…/project/srpipqrxggmfeagomvnk/auth/users** (Add user → Auto-confirm), then in the
  staging SQL editor: `update identity.accounts set role='admin' where lower(email)=lower('<you>');`

---

## Not in this doc (because they're coding tasks, handled elsewhere)

- **FE `SERVED` flips** + pin `^0.15.0` — run the FE prompt in a Yaycay-FE Claude
  session, or re-scope a session to `yaycay-fe`.
- **Admin / FE adopting v0.15** (user types + PIN) — consumer-side wiring.

These are tracked in `docs/handoff/FE-HANDOFF.md` / `ADMIN-HANDOFF.md`.
