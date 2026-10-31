#!/usr/bin/env python3
"""Read-only schema probe for the HeyMino Supabase project."""
import json
import os
import sys
import urllib.request
import urllib.error

REF = "odyywykbaahgmnvashrs"
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")


def q(sql):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return True, json.loads(r.read().decode() or "[]")
    except urllib.error.HTTPError as e:
        return False, e.read().decode()


QUERIES = {
    "tables": """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY 1""",
    "ai_usage columns": """
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ai_usage' ORDER BY ordinal_position""",
    "profiles columns": """
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' ORDER BY ordinal_position""",
    "otp_codes columns": """
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='otp_codes' ORDER BY ordinal_position""",
}

for name, sql in QUERIES.items():
    ok, res = q(sql)
    print(f"\n== {name} ==")
    if not ok:
        print("  ERROR:", res)
        continue
    for row in res:
        print("  ", row)
