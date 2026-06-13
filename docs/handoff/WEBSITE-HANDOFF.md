# Website handoff — confirm / develop

**Contract:** `@alkazat/contracts@^0.13.0`. **Base URL:**
`https://<project-ref>.supabase.co/functions/v1` (prod ref `nzmjkbjtcjthjwdscjrj`).
Both endpoints are **public** (no JWT) — send `apikey: <anon key>` only.

---

## CONFIRM — live in prod

| Endpoint (live URL) | Type | Note |
|---|---|---|
| `POST /demo-generate-day` | `DemoGenerateDayResponse` | the free-demo hook; real, rich AI day for one child + a grown-ups teaser. Rate-limited per IP. |
| `POST /signup-capture` | `SignupCaptureResponse` | lead capture + Brevo sync with consent; idempotent on email. |

`generated_by` (`"ai"` | `"fallback"`) is on the demo response if you want to
detect/instrument fallback.

---

## DEVELOP — still pending

- Nothing BE-side. Both website endpoints are served and stable.
- (Marketing email volume) the demo/signup funnel relies on Brevo + the project's
  email sender; confirm `BREVO_API_KEY` is set if you want live contact sync.
