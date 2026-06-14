# Backend stores — chat/companion + MCP OAuth grants

Spec for the two new back-end stores approved in the BE thread. **Status: in
build** (this doc is the contract/plan; code + contract version follow).

---

## A. Planning chat + companion store (demo screenshots #1/#4/#6/#12)

Why: planning chat is stateless SSE streaming, so "reopenable chat" and seeded
"what's nearby" companion answers had nowhere to live. These two tables back them
so the demo (and, later, real users) can persist + reopen.

### Tables (migration)

`public.trip_chat_messages`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| trip_id | uuid → trips(id) cascade | |
| user_id | uuid → auth.users cascade | owner |
| role | text | `user` \| `assistant` |
| kind | text | `text` \| `import_chip` (e.g. forwarded hotel confirmation) |
| content | text | message body |
| meta | jsonb | chip details, etc. (nullable) |
| seq | int | stable ordering within a trip |
| created_at | timestamptz | |

`public.trip_companion_cards`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| trip_id | uuid → trips(id) cascade | |
| user_id | uuid → auth.users cascade | owner |
| near_label | text | e.g. "near Gardens by the Bay" |
| prompt | text | the question, e.g. "what's good to eat near here" |
| options | jsonb | `[{ name, flags: string[], note }]` — flags carry the tree-nut label |
| rain_plan | jsonb | `{ title, body }` one-tap indoor fallback |
| created_at | timestamptz | |

RLS: owner `select`; all writes via service role (admin upload + seed).

### Endpoints

Consumer (FE reads to render), user-scoped JWT:
- `GET /trips/{id}/chat` → `{ messages: ChatMessage[] }`
- `GET /trips/{id}/companion` → `{ cards: CompanionCard[] }`

Admin upload (the "URL to upload to"), admin + AAL2, audited:
- `PUT /admin/trips/{id}/chat` — body `{ messages: [...] }` → replaces the trip's
  chat; returns `{ messages }`.
- `PUT /admin/trips/{id}/companion` — body `{ cards: [...] }` → replaces; returns
  `{ cards }`.

### Seed
The Walker demo seed is extended to populate the Singapore trip's chat (3 Q&A +
a hotel-confirmation `import_chip`) and one companion card (2 options with
tree-nut flags + confirm notes + a rain plan), so screenshots #1/#4/#6/#12 are
real on re-run.

---

## B. MCP OAuth-grant store (Admin "Connected assistants")

Why: Admin needs a cross-account list + revoke kill-switch over the OAuth grants
behind the BYO-AI MCP server. BE had only the older trip-scoped `connectors`
(v0.6); per the Admin handoff, BE now owns a durable shared grant store.

### Table (migration)

`public.oauth_grants`
| column | type | notes |
|---|---|---|
| id | uuid pk | grant id (used to revoke) |
| user_id | uuid → auth.users cascade | the parent |
| client_id | text | OAuth client id (RFC 7591 dynamic registration) |
| assistant | text | human label, e.g. "Claude (claude.ai)" |
| scopes | text[] | subset of `yaycay.read`, `yaycay.plan` |
| status | text | `active` \| `revoked` |
| token_version | int | bumped on revoke so old tokens fail verification |
| created_at | timestamptz | |
| last_used_at | timestamptz | last tool call (nullable) |
| revoked_at | timestamptz | nullable |

RLS: owner `select` (FE self-service); admin + service role full. **FE's MCP
server must write grants here** (create on OAuth grant, stamp `last_used_at` per
tool call, and check `status='active'` + `token_version` in `verifyMcpToken`).

### Admin endpoints (admin + AAL2, audited)
- `GET /admin/connectors?query=&cursor=` → `{ items: AdminConnector[], nextCursor }`
  (`query` filters owner email / assistant).
- `POST /admin/connectors/{id}/revoke` → `AdminConnector` (status=revoked):
  sets `status='revoked'`, `revoked_at=now()`, bumps `token_version` (so the next
  `/api/mcp` call fails auth). Audited as `connector.revoke`.

`AdminConnector` = `{ id, userId, ownerEmail, assistant, clientId, scopes,
status, createdAt, lastUsedAt }`.

### Observability + review (the two cross-cutting asks)
- **5a:** `ai_jobs` already has a `source` column. Connector-driven `plan_trip`
  writes log an `ai_jobs` row with `source='connector'` (+ `connector_id` /
  `assistant`), so ops see them and the daily cap applies.
- **5b:** connector-driven `trip_content` changes are flagged into the existing
  `content-review` pipeline (no external model bypasses the review bar).

### Dependency on FE
This store is only effective once the FE MCP server (a) creates grant rows here,
(b) reads/validates them in `verifyMcpToken` (honouring `status` +
`token_version`), and (c) stamps `last_used_at`. Until then, the admin list shows
no rows and revoke has nothing to cut. BE will expose the table + endpoints; FE
must wire to it.

---

## Sequencing
1. **A (chat/companion)** ships first — self-contained, unblocks the demo shots.
2. **B (oauth_grants + admin connectors + ai_jobs source + review)** next, then
   publish `@alkazat/contracts` and reply with the version for Admin to re-pin.
