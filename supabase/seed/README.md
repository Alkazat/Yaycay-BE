# Walker-family demo seed

A single, stable, idempotent demo customer for marketing screenshots
(`Yaycay-Website` / `IMAGE-BRIEFS-screenshots.md`): the **Walker family's
completed Singapore trip**.

## What it creates

- **Account** `demo.walker@yaycay.example` (override with `DEMO_WALKER_EMAIL`),
  email-confirmed, password from `DEMO_WALKER_PASSWORD`. Flagged `is_demo=true`
  in `identity.accounts` (excluded from analytics/billing/marketing/cleanup).
- **Profiles**: Riley Walker (`parent_carer`, holds the Grown-ups PIN), Sam
  (`child`, `explorer`, age 9), Pip (`child`, `little`, age 6, **tree-nut
  allergy** in `dietary`/`medical`).
- **Trip**: a completed 4-day Singapore trip, `tier=ours` (paying "Done for
  you", so no paywall banners), `retention_expires_at=NULL` (the disposal sweep
  only deletes trips with a non-null retention date, so this is safe forever).
- **Trip content**: `walker-singapore.trip-content.json`, validated against
  `packages/contracts/schemas/trip-content.schema.json`. Day 2 is the hero:
  per-child mornings at Gardens by the Bay, the flagged Satay-by-the-Bay lunch
  with the bilingual ask-the-kitchen card, an ArtScience Museum rain plan, and a
  quiet pool evening. Grown-ups block carries the EpiPen/allergy protocol +
  checklist.
- **Purchase** row so the account derives the `ours` tier.
- **Journal**: Pip's Day-2 keepsake page.

## Run

Against staging or prod, from the repo root:

```bash
SUPABASE_URL=https://nzmjkbjtcjthjwdscjrj.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
DEMO_WALKER_PASSWORD=<vault password> \
DEMO_WALKER_PIN=<4-digit pin> \
deno run -A supabase/seed/walker-demo.ts
```

(The `-A` allows env/net/read-write; the colocated `deno.json` here turns on
`nodeModulesDir: auto` so the Supabase library's npm sub-deps install on first
run. If `deno` isn't on your PATH after install, call it as `~/.deno/bin/deno`.)

- **Service role key**: Supabase Dashboard -> Project Settings -> API ->
  `service_role` (secret). Do not commit it.
- **Record `DEMO_WALKER_PASSWORD` and `DEMO_WALKER_PIN` in the team vault.**
  Without them the script uses obvious defaults and warns.

Re-running is safe: every row uses a fixed id and is upserted.

## Reset

```sql
-- Supabase SQL editor. Cascades trips/journal/profiles; purchases anonymize.
delete from auth.users where email = 'demo.walker@yaycay.example';
```

(Or use the admin Data Deletion console: `POST /admin/deletion-requests/{userId}/execute`.)

## Planning chat + companion (now server-backed, v0.21)

The seed also populates the **reopenable planning chat** (3 Q&A + a forwarded
hotel-confirmation chip) and a **"what's nearby" companion card** (2 tree-nut
flagged options + a rain plan) into the v0.21 chat/companion store, so
screenshots #1/#4/#6/#12 render from real data. The FE reads them at
`GET /trips/{id}/chat` and `GET /trips/{id}/companion`; ops can re-upload via
`PUT /admin/trips/{id}/chat` and `/companion`.

## Hand-off

This seed is the `Yaycay-BE` deliverable. Still required, in other repos:

1. **Run** the command above against the target project (needs the service-role
   key + network; cannot run from CI/sandbox).
2. **`Yaycay-FE`**: log in as the demo account, confirm every screen in
   `IMAGE-BRIEFS-screenshots.md` renders cleanly, fix empty-state gaps, supply
   the chat/companion fixtures noted above, then capture screenshots.

---

# Carmen-family demo seed

A second stable, idempotent demo customer showcasing the **trip economics
layer** (0036): per-child challenges, budget, cost tracking, and the star
reward economy. The trip is a **12-day Singapore family holiday** starting
2026-06-26 with four profiles: Carmen (parent), Savy (older explorer), Tay
(middle child), and Lenny (youngest, tree-nut allergy).

## What it creates

- **Account** `demo.carmen@yaycay.example` (override with `DEMO_CARMEN_EMAIL`),
  email-confirmed, password from `DEMO_CARMEN_PASSWORD`. Flagged `is_demo=true`
  in `identity.accounts`.
- **Profiles**: Carmen (`parent_carer`, holds the Grown-ups PIN), Savy
  (`child`, `explorer_plus`, age 13), Tay (`child`, `explorer`, age 8), Lenny
  (`child`, `little`, age 5, **tree-nut allergy / anaphylaxis / EpiPen**).
- **Trip**: a 12-day Singapore trip, `tier=ours`, `status=ready` (trip starts
  today — 2026-06-26), `retention_expires_at=NULL` (disposal-safe).
- **Trip content**: `carmen-singapore.trip-content.json` — 12 days, currency
  SGD, d1=2026-06-26, d12=2026-07-07.
- **Purchase** row so the account derives the `ours` tier.
- **Economics layer** (four tables from `0036_trip_economics.sql`):
  - `trip_profile_challenges`: 24 rows — Savy's 12 day-level quizzes +
    Tay's 12 day-level challenges. Lenny earns via games only (no rows).
  - `trip_budget`: 1 row — SGD base, AUD home, exchange rate 1.10 as of
    2026-06-26, cash_budget=175 SGD.
  - `trip_costs`: 20 line-item costs across d1–d12 (Grab rides, admission
    tickets, buffets, activity passes). One pre-paid row: Rainforest Wild
    bundle (paid=true). SGD amounts; AUD amounts where available.
  - `trip_reward_config`: 1 trip-default row — star_value=3 SGD,
    star_target=36 (covers all 12 days), star_budget=108 SGD. No
    per-child overrides (profile_id=null = trip default).

Source data for the economics layer lives in
`carmen-singapore.economics.json` (icon/tag metadata included there for
reference, omitted from DB as no column exists in 0036).

## Run

Against staging or prod, from the repo root:

```bash
SUPABASE_URL=https://nzmjkbjtcjthjwdscjrj.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
DEMO_CARMEN_PASSWORD=<vault password> \
DEMO_CARMEN_PIN=<4-digit pin> \
deno run -A supabase/seed/carmen-demo.ts
```

- **Service role key**: Supabase Dashboard → Project Settings → API →
  `service_role` (secret). Do not commit it.
- **Record `DEMO_CARMEN_PASSWORD` and `DEMO_CARMEN_PIN` in the team vault.**
  Without them the script uses obvious defaults and warns.

Re-running is safe: every row uses a fixed id and is upserted (or for
`trip_reward_config`'s partial-unique default row: delete + insert).

## Reset

```sql
-- Supabase SQL editor. Cascades trips/economics/profiles; purchases anonymize.
delete from auth.users where email = 'demo.carmen@yaycay.example';
```

(Or use the admin Data Deletion console: `POST /admin/deletion-requests/{userId}/execute`.)
