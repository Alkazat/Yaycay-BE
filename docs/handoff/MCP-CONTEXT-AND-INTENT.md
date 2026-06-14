# MCP context + trip intent (planning vs serving)

**From:** Yaycay-BE
**To:** Yaycay-FE
**Re:** making the BYO-AI MCP carry real intent, and the planning/curation boundary
**Date:** 2026-06-14
**Writing rule:** no em-dashes.

The BYO-AI MCP used to be thin CRUD: an external assistant could read and edit the
itinerary tree but knew nothing about *why* the trip exists. It got the "what"
(Days, Moments, Activities) and none of the "who/how" (the family, the pace they
want, their must-dos and no-gos). So it could edit structure but not plan well,
and nothing it learned was kept for Yaycay's own use. This change closes that gap
in three moves, and draws a firm line between **planning** (collaborative, over
the MCP) and **serving/curation** (first-party, off the MCP).

## 1. The MCP is now self-describing

`initialize` returns an `instructions` brief (the content model, the planning
philosophy, and how to use the tools well), so the connecting assistant is framed
before it touches a tool. Keep it short and stable; it is read once per session.

Two new tools surface and capture intent:

- `get_trip_brief` - returns the trip header (destination, dates, tier), a
  minimised child-profile seed for travellers (name, age, mode, interests only;
  dietary and medical are deliberately not exported off-platform to the external
  assistant), and the captured intent. Assistants are told to call this first and
  plan to the brief. The family conveys any dietary/medical considerations
  deliberately via `set_trip_brief` constraints, which they control, rather than
  having them auto-shared from account profiles.
- `set_trip_brief` - patch-writes intent when the assistant learns what the
  family wants (only the fields passed are updated). This is the capture path:
  understanding gathered during a chat becomes durable, structured data.

Same channel, now also shipped: the brief is exposed as an MCP **resource**
(`yaycay://trip/<id>/brief`, listed per trip the token can reach) so an assistant
can pull context without a tool call, and a **prompt** (`plan_a_day`, with an
optional `focus`) encodes the house style so "plan a day for this family" needs
no re-explaining. `initialize` advertises `tools`, `resources`, and `prompts`.

## 2. Intent is first-class and shared (migration 0024_trip_intent)

`public.trip_intent` (one row per trip, owner-scoped RLS, mirrors `trip_content`)
holds: `pace`, `budget`, `travellers` (jsonb), `interests`, `must_do`, `avoid`,
`notes` (the family's own words), and a flexible `constraints` jsonb (nap windows,
mobility, allergy summary, travel sickness).

The key idea: **intent is captured once and read by both paths.** The MCP reads
it via `get_trip_brief` and refines it via `set_trip_brief` (gated by
`yaycay.plan`); Yaycay's own curation reads the same row. Context is never
re-derived, and it does not leak into the content tree.

`trip_content` stays the "what"; `trip_intent` is the "why". Travellers are a
trip-owned snapshot (a trip may include a subset of `child_profiles` plus other
adults), seedable from `child_profiles` but not coupled to it.

## 3. Planning is on the MCP; serving and curation stay first-party

Deliberate boundary, and the reason `mcp/index.ts` still calls no model:

- **Planning (MCP):** declarative reads/writes on structure (`add/update/move`,
  `set_packing_list`, `import_reservation`, `optimise_day`) and on intent
  (`get/set_trip_brief`). The parent's own assistant drives it; we run no model,
  so there is no inference cost to us and no brand/safety exposure through a
  third-party model.
- **Serving + curation (first-party, off the MCP):** recommendations,
  enrichment, kid-safe quality curation, real day optimisation, journaling
  prompts. These run server-side where Yaycay controls model cost, brand voice,
  child-safety, and data. They consume the same `trip_intent` + `trip_content`,
  plus the `ai_jobs` audit trail we already write on every MCP edit (a signal
  source for what assistants are doing).

They meet only through shared data, never by the MCP calling a model. That keeps
the third-party surface declarative and auditable while the experience Yaycay
curates and serves stays ours.

## How this rides on the auth work

`verifyMcpToken` dual-accepts connector tokens and account-scoped OAuth grants.
Account-scoped grants make the brief more important, not less: the assistant can
see all of the user's trips, so `get_trip_brief` (with `trip_id`) is how it picks
the right trip and understands each one. Scopes map cleanly: `yaycay.read` reads
the brief, `yaycay.plan` writes structure and intent; serving-side concerns
(`yaycay.book`, `yaycay.journal`) stay gated or first-party.

Connector tool-name scopes (`CONNECTOR_DEFAULT_SCOPES`) are enforced per tool at
`tools/call`: a connector may invoke only the tools present in its
`connectors.scopes` row (a `-32002` error otherwise). Connectors are minted with
the full default set today, so behaviour is unchanged, but any narrowed grant
issued by FE or ADMIN is now actually enforced rather than advisory.

## Status

- SHIPPED: `initialize` instructions + capabilities (tools/resources/prompts);
  `get_trip_brief` / `set_trip_brief`; brief as MCP resource and the `plan_a_day`
  prompt; migration `0024_trip_intent`; default connector scopes updated.
- SHIPPED: first-party planning chat (`POST /trips/:id/chat`) now reads
  `trip_intent` via the shared `_shared/trip-intent.ts` module and feeds the
  family's brief into the planning companion's context - the same brief the MCP
  exposes, so both paths plan to one understanding.
- SHIPPED: `get_trip_brief` minimises the child-profile seed (name, age, mode,
  interests only; no dietary/medical exported off-platform), and connector
  tool-name scopes are enforced per tool at `tools/call`.
- NEXT: have the demo/ingest curation surfaces read `trip_intent` too; optionally
  seed `travellers` from `child_profiles` on first brief read; consider exposing
  the brief resource via `resources/templates` for clients that prefer templated
  URIs.
