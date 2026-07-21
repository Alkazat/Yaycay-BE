#!/bin/bash
# Yaycay MCP smoke-test - SessionStart hook.
# Arms a fresh Claude Code (web) session: derives env, reports which secrets are
# present, and probes egress to every Yaycay dependency host. Non-interactive,
# idempotent, safe to run every session. Runs synchronously so the connectivity
# report is in context before the agent starts.
set -uo pipefail

# Only meaningful in the remote (web) environment; no-op locally.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

KIT="${CLAUDE_PROJECT_DIR:-.}/tools/mcp-smoketest"

# Derive the edge-functions base from SUPABASE_URL when not already set.
if [ -z "${YAYCAY_API_BASE:-}" ] && [ -n "${SUPABASE_URL:-}" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export YAYCAY_API_BASE=\"${SUPABASE_URL%/}/functions/v1\"" >> "$CLAUDE_ENV_FILE"
fi

echo "== Yaycay smoke-test kit armed =="
echo "secrets present:"
for v in SUPABASE_PAT SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY \
         STRIPE_TEST_KEY IDENTITY_SUPABASE_URL YAYCAY_CONNECTOR_TOKEN; do
  if [ -n "${!v:-}" ]; then echo "  [x] $v"; else echo "  [ ] $v (missing)"; fi
done

echo "egress probe:"
if [ -f "$KIT/01-reachability.sh" ]; then
  bash "$KIT/01-reachability.sh" 2>/dev/null | sed 's/^/  /'
else
  echo "  (probe not found at $KIT - kit may not be checked out on this branch)"
fi

echo "next: bash $KIT/02-supabase-rw.sh  &&  bash $KIT/03-yaycay-mcp-endpoint.sh"
