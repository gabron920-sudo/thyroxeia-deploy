#!/usr/bin/env python3
"""Read-only deep probe: RLS, policies, triggers, indexes, duplicates."""
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
    "RLS enabled": """
        SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('profiles','ai_usage','shoutouts','decks','app_decks','app_user_state')
        ORDER BY 1""",
    "existing policies": """
        SELECT tablename, policyname, cmd FROM pg_policies
        WHERE schemaname='public' ORDER BY tablename, policyname""",
    "existing triggers on profiles": """
        SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname='profiles' AND NOT t.tgisinternal""",
    "indexes on profiles": """
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='profiles'""",
    "duplicate subscription ids": """
        SELECT paypal_subscription_id, count(*) FROM profiles
        WHERE paypal_subscription_id IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1""",
    "plan distribution": """
        SELECT plan, count(*) FROM profiles GROUP BY 1 ORDER BY 2 DESC""",
    "paid without subscription": """
        SELECT id, plan, subscription_status, created_at FROM profiles
        WHERE plan <> 'free' AND paypal_subscription_id IS NULL
        ORDER BY created_at DESC LIMIT 20""",
    "app_decks columns": """
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='app_decks' ORDER BY ordinal_position""",
    "ai_usage rowcount": "SELECT count(*) AS rows FROM ai_usage",
    "ai_usage sample": "SELECT * FROM ai_usage ORDER BY date DESC LIMIT 3",
}

for name, sql in QUERIES.items():
    ok, res = q(sql)
    print(f"\n== {name} ==")
    if not ok:
        print("  ERROR:", res)
        continue
    if not res:
        print("  (empty)")
    for row in res:
        print("  ", row)
