# P1 — Auth end-to-end + real trips (verification runbook)

Everything BE needs for a signed-in family is **already built and deployed**:
`auth-2fa-verify`, the `/trips` + per-trip surfaces, RLS on every customer table,
and the isolated identity store for `/admin`. P1 is therefore a **configuration +
verification** task on the Supabase projects, not new BE code. This runbook is the
checklist to confirm it works end to end.

> Key clarification: **customer routes only need a valid session.** The gateway
> (`verify_jwt = true`) checks the JWT signature; the handler runs as the caller
> so RLS scopes rows to them. **AAL2 (verified MFA) is required only for
> `/admin/*`.** So `GET /trips` works the moment a user has *any* authenticated
> session — magic link alone is enough. 2FA elevates the session to AAL2 (needed
> for admins); it is not a gate on the customer app.

## 0. Which project

Run each step against the project the app points at. Production is
`SUPABASE_PROJECT_REF`; staging is `STAGING_PROJECT_REF`. Base URL:
`https://<ref>.supabase.co`. You need that project's **anon key** (Dashboard ->
Settings -> API) for the `apikey` header.

## 1. Supabase Auth configuration (Dashboard)

- **Auth -> Providers -> Email:** enabled. Choose the sign-in style the FE ships:
  - *Magic link* (passwordless link), and/or
  - *Email OTP* (6-digit code). Either issues a session; pick what the FE uses.
- **Auth -> URL Configuration:** add the FE origins to **Site URL** and
  **Redirect URLs** (localhost for dev + the deployed FE origin), so magic-link
  redirects are accepted.
- **Auth -> MFA:** enable **TOTP** (only needed for the `/admin` AAL2 path and any
  customer 2FA the FE chooses to enrol). Customer sign-in does not require it.
- **Email templates:** confirm the magic-link / OTP templates send (SMTP or the
  built-in sender). Transactional email for 2FA codes rides the same sender.

## 2. The session flow (what the FE does)

1. FE calls `supabase.auth.signInWithOtp({ email })` (magic link / OTP). User
   clicks the link or enters the code -> a session (access + refresh JWT) is
   established at **AAL1**.
2. FE attaches that JWT to every API call:
   `Authorization: Bearer <access_token>` **and** `apikey: <anon key>`.
3. (Admins / opt-in 2FA only) FE enrols a TOTP factor, then calls
   `POST /auth-2fa-verify { code }` -> session elevates to **AAL2**. `/admin/*`
   requires this; `/trips` does not.

## 3. Verify (curl)

Set `BASE=https://<ref>.supabase.co/functions/v1`, `ANON=<anon key>`,
`JWT=<a real user access token>` (grab one from the FE devtools after sign-in, or
mint via the Supabase CLI).

```bash
# 3a. Unauthenticated -> 401 (gateway rejects a missing/!valid JWT)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $ANON" "$BASE/trips"            # expect 401

# 3b. Authenticated -> 200 + the caller's own trips (empty array if none yet)
curl -s -H "apikey: $ANON" -H "Authorization: Bearer $JWT" "$BASE/trips"
# expect {"trips":[...]}

# 3c. Create a trip, then list again -> it appears (and only for this user)
curl -s -X POST -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"destination":"Lisbon"}' "$BASE/trips"
```

Pass criteria:
- 3a returns **401** (gateway `verify_jwt`).
- 3b returns **200** with `{ trips: [...] }` scoped to that user.
- 3c creates and the trip shows up on the next `GET /trips`.

## 4. RLS isolation (already proven, re-confirm live)

With two different users' JWTs, user B's `GET /trips` must never show user A's
trips, and `GET /trips/{A's id}` as B must 404. (This is enforced by
`trips_owner_all` and covered by the pgTAP `rls_test.sql`; the live check just
confirms the deployed project has RLS forced — it does, via the migrations.)

## 5. 2FA elevation (only if the FE enrols customer 2FA, and for admins)

```bash
# After enrolling a TOTP factor for the user:
curl -s -X POST -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"code":"123456"}' "$BASE/auth-2fa-verify"
# expect {"verified":true}; the session is now AAL2.
```

`GET /admin/me` with an AAL2 admin JWT returns the admin session; a non-admin or
AAL1 caller gets 403. (Admin role is resolved from the isolated identity store,
not a JWT claim — see CONTRACT-STATUS "Admin auth claim shape".)

## Definition of done

- A real magic-link / OTP sign-in yields a JWT the gateway accepts.
- `GET /trips` and `GET /trips/:id` return that user's real trips; RLS isolates
  accounts.
- `auth-2fa-verify` elevates to AAL2; `/admin/*` requires it, customer routes do
  not.

Nothing here needs a BE code change — if a step fails it points at a Dashboard
auth setting (email provider, redirect URLs, or MFA enablement) on that project.
