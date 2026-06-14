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
deno run --allow-env --allow-net supabase/seed/walker-demo.ts
```

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

## Known gap (not BE-seedable)

The brief asks for a **reopenable planning chat** (3 Q&A + a forwarded
hotel-confirmation chip) and **canned "what's nearby" companion answers**.
Planning chat is stateless SSE streaming and there is **no chat-history or
companion table** in the back end, so these cannot be seeded server-side. Those
screenshots (#1, #4, #6, #12) need FE mock/fixture state in `Yaycay-FE`. Flag to
the FE thread; if we want them server-backed, that's a new contract + tables
(separate task).

## Hand-off

This seed is the `Yaycay-BE` deliverable. Still required, in other repos:

1. **Run** the command above against the target project (needs the service-role
   key + network; cannot run from CI/sandbox).
2. **`Yaycay-FE`**: log in as the demo account, confirm every screen in
   `IMAGE-BRIEFS-screenshots.md` renders cleanly, fix empty-state gaps, supply
   the chat/companion fixtures noted above, then capture screenshots.
