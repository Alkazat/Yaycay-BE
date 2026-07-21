#!/usr/bin/env bash
# Supabase READ/WRITE smoke test against a project's PostgREST + Storage.
# Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
# Uses a throwaway table so nothing real is touched. Cleans up after itself.
set -euo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL (e.g. https://<ref>.supabase.co)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY}"

H_KEY="apikey: ${SUPABASE_SERVICE_ROLE_KEY}"
H_AUTH="Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"

echo "== 1. Auth health =="
curl -s "${SUPABASE_URL}/auth/v1/health" -H "$H_KEY" ; echo

echo "== 2. READ: list first products row (public schema) =="
curl -s "${SUPABASE_URL}/rest/v1/products?select=*&limit=1" -H "$H_KEY" -H "$H_AUTH" ; echo

echo "== 3. WRITE round-trip via a scratch table =="
echo "   (Create a scratch table once via SQL:"
echo "    create table if not exists public._smoketest(id uuid primary key default gen_random_uuid(), note text, at timestamptz default now());"
echo "    Then this inserts + deletes a row.)"
ROW=$(curl -s -X POST "${SUPABASE_URL}/rest/v1/_smoketest" \
  -H "$H_KEY" -H "$H_AUTH" -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"note":"mcp-smoke-test"}')
echo "  inserted: $ROW"
ID=$(printf '%s' "$ROW" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -n "${ID:-}" ]; then
  curl -s -X DELETE "${SUPABASE_URL}/rest/v1/_smoketest?id=eq.${ID}" -H "$H_KEY" -H "$H_AUTH" -w "  deleted HTTP %{http_code}\n" -o /dev/null
fi

echo "== 4. Storage: list buckets (read) =="
curl -s "${SUPABASE_URL}/storage/v1/bucket" -H "$H_KEY" -H "$H_AUTH" ; echo
