# Yaycay MCP smoke-test kit

Verifies read/write connectivity to every service the Yaycay repos depend on,
and stands up MCP controllers for them. Lives here so a fresh Claude Code (web)
session self-arms via the `.claude/hooks/session-start.sh` SessionStart hook.

## Why a fresh session is needed

An environment's **network egress policy** and **secrets** are baked into the
container when the session starts. Editing them does not reach an already-running
session. Start a NEW session on an environment where both are configured.

## 1. Egress - allow these hosts on the environment

```
srpipqrxggmfeagomvnk.supabase.co      # Supabase staging (data + edge functions)
nzmjkbjtcjthjwdscjrj.supabase.co      # Supabase prod   (data + edge functions)
api.supabase.com                      # Supabase Management API (Supabase MCP server)
api.stripe.com                        # Stripe MCP + API
api.brevo.com                         # Brevo email (optional)
api.openai.com                        # OpenAI harness (optional)
generativelanguage.googleapis.com     # Gemini harness (optional)
<identity-project>.supabase.co        # isolated identity store (send its ref)
```

Probe reads: `000` = still blocked, `401/403` = reachable (good), `200` = open.

## 2. Secrets - set on the environment (never commit)

| Env var | Purpose |
|---|---|
| `SUPABASE_PAT` | Supabase personal access token; drives both Supabase MCP servers |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | staging project, direct DB read/write test |
| `SUPABASE_ANON_KEY` | public gateway key for edge-function tests |
| `STRIPE_TEST_KEY` | Stripe restricted **test-mode** key |
| `IDENTITY_SUPABASE_URL` | isolated identity project |
| `YAYCAY_CONNECTOR_TOKEN` | optional; exercises the BYO-AI `/mcp` endpoint |

## 3. Run

```bash
bash tools/mcp-smoketest/01-reachability.sh        # no creds - egress check
bash tools/mcp-smoketest/02-supabase-rw.sh         # Supabase read + write round-trip
bash tools/mcp-smoketest/03-yaycay-mcp-endpoint.sh # Yaycay public fns + /mcp
```

## 4. MCP controllers

`mcp.json` is a draft config for the Supabase (staging + prod, `--read-only` to
start) and Stripe MCP servers, wired to the secrets above. Drop the read-only
flag once read tests pass to enable writes. Validate staging before prod.

Safety: keep prod service-role at read-only unless prod write is explicitly
wanted; use Stripe **test** keys; secrets come from the env store, not chat.

## 5. Environment notes (verified in the web env)

Two hosts beyond the app + api.stripe.com + api.supabase.com set are needed for
the full default MCP configs. Until they are on the egress allowlist:

- **Supabase MCP**: run with `--features=database`. The default feature set
  includes a `docs` group that fetches the Supabase Content API GraphQL schema
  during `tools/list`; that host is blocked (403) and fails the handshake.
  Scoping to `database` gives the read/write DB tools with no blocked fetch.
- **Stripe MCP**: pin `@stripe/mcp@0.2.5`, which runs tools locally against
  `api.stripe.com`. From `@0.3.x` the package proxies to the hosted
  `mcp.stripe.com`, which is blocked (403). The direct Stripe REST API on
  `api.stripe.com` works with the test key regardless.

Also note: DDL for the `_smoketest` scratch table cannot go through the
service-role key (PostgREST does no DDL). Create it via the Management API
query endpoint with `SUPABASE_PAT`, or in the SQL editor, before running
`02-supabase-rw.sh`.
