#!/usr/bin/env python3
"""Run the HeyMino Supabase migration statement-by-statement via the Management API.

The Management API's /database/query endpoint expects one statement per call for
reliable error reporting, so this splits the .sql file at real statement boundaries
(using a Postgres parser) and sends them in order, stopping at the first failure.
"""
import json
import os
import sys
import urllib.request
import urllib.error

import pglast

REF = "odyywykbaahgmnvashrs"
import os
SQL_PATH = os.environ.get("MIGRATION_FILE", "/tmp/hey/supabase_migration.sql")
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "")

if not TOKEN:
    sys.exit("SUPABASE_ACCESS_TOKEN not set")


def split_statements(sql):
    """Return exact statement texts, preserving comments attached above each one."""
    parsed = pglast.parse_sql(sql)
    bounds = [(s.stmt_location, s.stmt_len) for s in parsed]
    out = []
    prev_end = 0
    for start, length in bounds:
        # comments between statements belong with the following statement
        text = sql[prev_end:start + length] if prev_end <= start else sql[start:start + length]
        text = text.strip()
        # drop leading comment-only chunks so the API gets pure SQL
        while text.startswith("--"):
            nl = text.find("\n")
            if nl == -1:
                text = ""
                break
            text = text[nl + 1:].strip()
        text = text.lstrip(";").strip()
        if text:
            out.append(text)
        prev_end = start + length
    return out


def run_query(query):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode() or "[]"
            try:
                return True, json.loads(body), resp.status
            except json.JSONDecodeError:
                return True, body, resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return False, json.loads(body), e.code
        except json.JSONDecodeError:
            return False, body, e.code
    except Exception as e:  # noqa: BLE001
        return False, {"message": str(e)}, 0


def main():
    sql = open(SQL_PATH, encoding="utf-8").read()
    statements = split_statements(sql)
    print(f"{len(statements)} statements to run\n")

    failures = 0
    for i, stmt in enumerate(statements, 1):
        label = " ".join(stmt.split())[:78]
        ok, result, code = run_query(stmt)
        if ok:
            print(f"[{i:02d}/{len(statements)}] OK   {label}")
        else:
            msg = result.get("message") if isinstance(result, dict) else str(result)
            print(f"[{i:02d}/{len(statements)}] FAIL {label}\n        -> {msg}")
            failures += 1
            # a failed DDL makes later statements unreliable; stop and report
            break

    print(f"\nfailures: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
