#!/usr/bin/env bash
# Smoke test Yaycay-BE's own endpoints, including the BYO-AI /mcp connector.
# Public endpoints need no auth. The /mcp endpoint needs a connector token
# (minted by the JWT-gated `connectors` function for a signed-in user).
set -uo pipefail

BASE="${YAYCAY_API_BASE:?set YAYCAY_API_BASE=https://<ref>.supabase.co/functions/v1}"
ANON="${SUPABASE_ANON_KEY:-}"     # Supabase gateway needs apikey even for public fns
CONNECTOR_TOKEN="${YAYCAY_CONNECTOR_TOKEN:-}"  # optional; enables the /mcp test

hdr=(-H "apikey: ${ANON}")

echo "== Public: catalogue (read product catalogue) =="
curl -s "${hdr[@]}" "${BASE}/catalogue" -w "\n  HTTP %{http_code}\n"

echo "== Public: demo-generate-day (deterministic fallback, no AI key needed) =="
curl -s -X POST "${hdr[@]}" -H "Content-Type: application/json" \
  -d '{"destination":"Adelaide","date":"2026-08-01","party":{"adults":2,"children":[8]}}' \
  "${BASE}/demo-generate-day" -w "\n  HTTP %{http_code}\n"

if [ -n "$CONNECTOR_TOKEN" ]; then
  echo "== BYO-AI /mcp: initialize (JSON-RPC) =="
  curl -s -X POST "${BASE}/mcp" \
    -H "apikey: ${ANON}" -H "Authorization: Bearer ${CONNECTOR_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' -w "\n  HTTP %{http_code}\n"

  echo "== BYO-AI /mcp: tools/list =="
  curl -s -X POST "${BASE}/mcp" \
    -H "apikey: ${ANON}" -H "Authorization: Bearer ${CONNECTOR_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' -w "\n  HTTP %{http_code}\n"
else
  echo "== /mcp test SKIPPED: set YAYCAY_CONNECTOR_TOKEN to run it =="
fi
