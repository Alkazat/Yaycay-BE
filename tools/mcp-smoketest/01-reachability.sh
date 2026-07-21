#!/usr/bin/env bash
# Yaycay dependency reachability probe. No credentials required.
# Confirms the environment egress can reach each dependent service host.
# Run AFTER egress is opened for these hosts. HTTP 000 = still blocked by proxy.
set -u

STAGING_REF="srpipqrxggmfeagomvnk"
PROD_REF="nzmjkbjtcjthjwdscjrj"

probe() { # label url
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$2")
  printf "  %-46s HTTP %s\n" "$1" "$code"
}

echo "== Supabase (app) =="
for ref in "$STAGING_REF" "$PROD_REF"; do
  echo "-- $ref --"
  probe "auth/v1/health"      "https://$ref.supabase.co/auth/v1/health"
  probe "rest/v1/ (expect 401 no key)" "https://$ref.supabase.co/rest/v1/"
  probe "functions/v1/catalogue (public)" "https://$ref.supabase.co/functions/v1/catalogue"
  probe "functions/v1/shared (public)"    "https://$ref.supabase.co/functions/v1/shared"
done

echo "== Third-party control planes =="
probe "Supabase Management API"  "https://api.supabase.com/v1/projects"   # 401 w/o PAT = reachable
probe "Stripe API"               "https://api.stripe.com/v1"              # 401 w/o key = reachable
probe "Brevo API"                "https://api.brevo.com/v3/account"       # 401 w/o key = reachable
probe "Anthropic API"            "https://api.anthropic.com/v1/models"    # 401 w/o key = reachable
probe "OpenAI API"               "https://api.openai.com/v1/models"       # 401 w/o key = reachable
probe "Google Generative AI"     "https://generativelanguage.googleapis.com/v1/models"
echo
echo "Reading of HTTP codes:"
echo "  000        = egress still blocked (proxy 403 CONNECT) -> open the host"
echo "  401/403    = reachable, just needs a key (GOOD for a reachability probe)"
echo "  200        = reachable and open"
