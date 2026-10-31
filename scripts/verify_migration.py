#!/usr/bin/env python3
"""Verify the live hardening migration took effect (read-only + one safe rollback test)."""
import json
import os
import urllib.request
import urllib.error

REF = "odyywykbaahgmnvashrs"
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]


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


CHECKS = {
    "profiles policies": """SELECT policyname, cmd, qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='profiles' ORDER BY 1""",
    "ai_usage policies": """SELECT policyname, cmd, qual FROM pg_policies
        WHERE schemaname='public' AND tablename='ai_usage' ORDER BY 1""",
    "shoutouts policies": """SELECT policyname, cmd, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='shoutouts' ORDER BY 1""",
    "trigger": "SELECT tgname FROM pg_trigger WHERE tgname='protect_profile_billing'",
    "unique index": "SELECT indexname FROM pg_indexes WHERE indexname='profiles_paypal_subscription_uidx'",
    "new tables": "SELECT to_regclass('public.paypal_plans') AS paypal_plans, to_regclass('public.otp_codes') AS otp_codes",
    "ai_usage columns": """SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ai_usage' ORDER BY ordinal_position""",
    "any remaining world-writable policy": """SELECT tablename, policyname FROM pg_policies
        WHERE schemaname='public' AND cmd IN ('ALL','UPDATE','DELETE','INSERT')
          AND COALESCE(qual, with_check) = 'true'""",
}

for name, sql in CHECKS.items():
    ok, res = q(sql)
    print(f"\n== {name} ==")
    if not ok:
        print("  ERROR:", res)
        continue
    if not res:
        print("  (none)")
    for row in res:
        print("  ", row)

# ── safe proof: a normal logged-in user must NOT be able to change their plan ──
ok, res = q("SELECT id, plan FROM profiles WHERE plan = 'free' LIMIT 1")
if not ok or not res:
    print("\n(no free user to test with)")
else:
    uid = res[0]["id"]
    print(f"\n== trigger test on user {uid[:8]}… (plan={res[0]['plan']}) ==")
    attack = f"""
    BEGIN;
      SELECT set_config('request.jwt.claims', json_build_object('sub','{uid}','role','authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      UPDATE profiles SET plan = 'elite' WHERE id = '{uid}';
    ROLLBACK;
    """
    ok, res = q(attack)
    if ok:
        print("  ❌ UPDATE SUCCEEDED — trigger did not block it:", res)
    else:
        blocked = "Billing fields are managed by the server" in res
        print("  ✅ blocked" if blocked else "  ⚠️ failed for another reason:", res[:220])
    ok2, res2 = q(f"SELECT plan FROM profiles WHERE id = '{uid}'")
    print("  plan now:", res2[0]["plan"] if ok2 and res2 else res2)
