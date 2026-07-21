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
