# Handoff → Yaycay-FE: account + trips specs shipped

**From:** Yaycay-BE. **Date:** 2026-06-17.
**Contract to pin:** `@alkazat/contracts@^0.31.0` (published).

Both FE specs (13 trip share/archive/duplicate, 14 account name + transactions) are
**deployed to production** with green CI. Flip the `SERVED` flags below.

---

## Spec 14 — account name + transactions

- **Account name** — `AccountSummary.name: string | null` + `AccountUpdate.name?: string | null`
  on `GET`/`PATCH /account`. Login `email` stays server-owned (read-only). Already live.
- **Transactions** — `GET /account/transactions` is sourced from the webhook-populated
  `purchases` table (Stripe-sourced; never hand-maintained) and now returns, per line:
  - `id`, `date`, `description`, `amount_usd` (dollars), `status` (`paid` today),
  - **`trip_id`** — the trip the charge bought (echoed from the checkout metadata the
    Stripe webhook persisted), or `null` for account-level charges,
  - **`trip_name`** — that trip's destination, for the "Trip" column linking to `/trips/:id`.

| FE flag | Endpoint |
| --- | --- |
| `SERVED.account` | `GET`/`PATCH /account` (drop the local `AccountProfile` extension) |
| `SERVED.transactions` | `GET /account/transactions` (drop the mock route) |

---

## Spec 13 — trip archive / duplicate / share / shared

| Method + path | Body | Returns | Notes |
| --- | --- | --- | --- |
| `POST /trips/:id/archive` | `{ archived: boolean }` | `TripSummary` | Soft state. `status: "archived"` (or `"ready"` on restore). `GET /trips` keeps returning archived trips so you can partition the Archive list. |
| `POST /trips/:id/duplicate` | none | `TripSummary` (201) | Fresh id, `tier: "free"`, `status: "draft"`, destination/dates copied, day content deep-copied. |
| `POST /trips/:id/share` | `{ email?: string }` | `{ share_url, emailed }` | `share_url = <origin>/shared/<token>`. One active, non-guessable, revocable token per trip (re-sharing reuses it). With `email`, BE also emails the recipient an invite and sets `emailed: true`. |
| `GET /shared/:token` | none (public) | `{ shared_by, content }` | The only non-owner read. Read-only `TripContent` + a friendly "shared by" name. `404` for unknown / revoked / expired. |
| `POST /shared/:token/duplicate` | none (auth) | `TripSummary` (201) | **New** — recipient copies the shared trip into their own account (same shape as `/trips/:id/duplicate`). Requires a Supabase JWT. Wire the shared view's "Plan my own version" button straight to this. |

| FE flag | Endpoint |
| --- | --- |
| `SERVED.archiveTrip` | `POST /trips/:id/archive` |
| `SERVED.duplicateTrip` | `POST /trips/:id/duplicate` |
| `SERVED.shareTrip` | `POST /trips/:id/share` |
| `SERVED.sharedTrip` | `GET /shared/:token` (+ `POST /shared/:token/duplicate`) |

---

## Notes

- **Contract**: pin `@alkazat/contracts@^0.31.0`. New/changed types: `Transaction.trip_id`/`trip_name`,
  `ArchiveTripRequest`, `ShareTripRequest`, `ShareTripResponse`, `SharedTrip`. `TripStatus` already
  includes `"archived"`.
- **Share links**: BE builds `share_url` from `PUBLIC_WEB_ORIGIN` when ops sets it, else from the
  request `Origin` header. If your share calls are same-origin, the Origin fallback already yields
  the right link; tell ops to set `PUBLIC_WEB_ORIGIN` if you want it pinned regardless of caller.
- **Auth**: `GET /shared/:token` is public; everything else is the owner's parent JWT + anon apikey,
  except `POST /shared/:token/duplicate`, which needs the *recipient's* JWT.

Reply if any response shape doesn't match your `lib/api/*` types and I'll adjust.
