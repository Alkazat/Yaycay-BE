# MCP change protocol (BE / FE / ADMIN)

**Writing rule:** no em-dashes.

The BYO-AI MCP is a contract shared across three repos. A change in one repo
often has MCP implications the others must absorb. This protocol makes sure
nothing slips through: every PR that touches an MCP surface is detected, the
implications are reviewed, and the shared manifest stays the single source of
truth.

## The single source of truth

`packages/contracts/src/mcp-surface.ts` (published as `@alkazat/contracts`) is the
canonical manifest of the MCP surface:

- `MCP_TOOLS` - the tools the MCP endpoint exposes.
- `CONNECTOR_DEFAULT_SCOPES` - the tool-name scopes minted into a connector token.
- `MCP_OAUTH_SCOPES` - the OAuth scope vocabulary (active + reserved).
- `TRIP_INTENT_FIELDS` - the columns of `trip_intent` (the shared "why").
- `MCP_TABLES` - the tables that carry MCP state.

BE, FE, and ADMIN all consume this package, so the manifest is the one place the
three repos agree.

## Two enforcement layers

1. **Hard drift check (BE).** `packages/contracts/scripts/validate.mjs` (run by
   the `contracts:validate` CI step) parses the live edge functions and fails if
   `MCP_TOOLS`, `CONNECTOR_DEFAULT_SCOPES`, or `TRIP_INTENT_FIELDS` have drifted
   from the manifest, and asserts every connector scope is a real tool. You
   cannot change a tool, scope, or intent field in code without updating the
   manifest, and vice versa.
2. **Impact gate (all repos).** `.github/workflows/mcp-guard.yml` flags any PR
   that touches an MCP-sensitive path, posts the impact checklist, and stays red
   until a maintainer acknowledges (the `mcp-impact: reviewed` label, or a ticked
   `- [x] MCP impact reviewed` in the PR description).

## What counts as an MCP implication

The checklist dimensions, each a reason this protocol exists:

- **Intent** - the family's desires (`trip_intent`, `get/set_trip_brief`).
- **Context** - what the assistant is told: the `initialize` instructions, the
  brief resource/prompt, the content model.
- **Data** - schema for `oauth_*`, `connectors`, `trip_intent`, `trip_content`
  (migration + RLS + manifest).
- **Scopes** - the OAuth scope vocabulary and its enforcement.
- **Tools** - tools added / renamed / removed (and their connector scopes).
- **Auth** - `verifyMcpToken`, the OAuth grant/token lifecycle, revocation.
- **Cross-repo propagation** - the matching changes in BE / FE / ADMIN.
- **Stakeholders** - who must be looped in (FE OAuth AS, ADMIN console, the
  first-party curation pipeline).

## When you change the MCP surface

1. Update `mcp-surface.ts` and the code together (the drift check enforces this).
2. Work through the checklist; note cross-repo follow-ups and link companion PRs.
3. Acknowledge the gate (label or PR-description tick).
4. If FE/ADMIN must change, open or reference their PRs so the contract lands in
   lockstep. Bump `@alkazat/contracts` when consumers need the new manifest.
