#!/usr/bin/env python3
"""Verify public.trip_profile_features exists on a Supabase project.

Used by .github/workflows/reconcile-staging-0031.yml after the repair + push.
Queries the Supabase Management API (host-agnostic, uses the access token) and
exits non-zero if the table is missing, so the workflow fails loudly rather
than trusting the migration history table alone.

Env:
  STAGING_PROJECT_REF    target project ref (staging)
  SUPABASE_ACCESS_TOKEN  account access token
"""
import json
import os
import sys
import urllib.error
import urllib.request

SQL = (
    "select "
    "to_regclass('public.trip_profile_features') is not null as table_exists, "
    "(select count(*) from information_schema.columns "
    " where table_schema='public' and table_name='trip_profile_features') as column_count, "
    "(select count(*) from pg_policies "
    " where schemaname='public' and tablename='trip_profile_features') as policy_count;"
)


def main() -> int:
    ref = os.environ.get("STAGING_PROJECT_REF", "")
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not ref or not token:
        print("STAGING_PROJECT_REF and SUPABASE_ACCESS_TOKEN must be set.", file=sys.stderr)
        return 1

    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": SQL}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # api.supabase.com sits behind Cloudflare, which returns a 403
            # "error code: 1010" for the default Python-urllib User-Agent.
            "User-Agent": "yaycay-ci-verify/1.0",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        print(f"Management API HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        return 1

    print("Management API response:", body)
    rows = json.loads(body)
    if not isinstance(rows, list) or not rows:
        print("VERIFICATION FAILED: query returned no rows.", file=sys.stderr)
        return 1
    row = rows[0]
    if row.get("table_exists") is not True:
        print("VERIFICATION FAILED: trip_profile_features does not exist on staging.", file=sys.stderr)
        return 1
    print(
        f"OK: trip_profile_features exists "
        f"(columns={row.get('column_count')}, policies={row.get('policy_count')})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
