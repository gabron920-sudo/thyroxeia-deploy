# HeyMino / Thyroxeia — security fixes

This patch addresses items 1–5 of Mark's review, and adds the operational notes for item 6.
Nothing here changes the UI or the plan limits. Everything is backwards compatible with the
current frontend.

**Files changed**

| File | Item |
|---|---|
| `routes/payment.js` | 1 — plan and ownership now come from PayPal, not the browser |
| `supabase_migration.sql` | 2 — billing columns are server-write-only; subscription can't be shared |
| `routes/ai-clean-lite.js` | 3 — model allowlist, input schema + caps, durable rate-limit hook |
| `worker-clean-lite.js` | 3 — comment only (in-memory Map is now explicitly a backstop) |
| `routes/auth-email.js` | 4 — real 5-attempt OTP limit |
| `public_fixed12/index.html` | 5 — AI output is escaped before rendering |
| `.env.example` | new PayPal plan IDs + webhook ID |
| `tests/*`, `package.json` | 62 regression checks (`npm test`) |

---

## 1. Payments trusted the browser

**Before:** `activate-subscription` took `plan` from the request body, never compared it with
`ppSub.plan_id`, and never checked `ppSub.custom_id` against the logged-in user.

**Now:**

- The plan is resolved server-side from PayPal's own record, in this order:
  1. `PAYPAL_STUDENT_PLAN_ID` / `PAYPAL_PRO_PLAN_ID` / `PAYPAL_ELITE_PLAN_ID` secrets,
  2. the new `paypal_plans` table (written by the Worker when it creates a plan on demand),
  3. the plan name we gave PayPal when creating it,
  4. the recurring price PayPal reports (PHP only).
  It never falls back to the client's value.
- `ppSub.custom_id` must equal the authenticated user's id, otherwise **403**.
- A subscription already bound to another profile is rejected (**409**), and a unique index now
  makes that impossible at the database level too.
- All billing writes go through one function, `applySubscriptionState()`, so the rules are identical
  in `activate-subscription`, `check-subscription`, `reconcile-subscription` and the webhook:
  - active + plan resolved → grant that plan;
  - inactive/cancelled → back to free;
  - **active but plan unresolvable → keep the current plan** and store the subscription so it can be
    reconciled later (a payer is never silently downgraded);
  - profile bound to a *different* subscription → ignore (stale webhook for an old subscription).
- The webhook verifies PayPal's signature when `PAYPAL_WEBHOOK_ID` is set and only touches the
  profile that owns the subscription.
- `reconcile-subscription` heals a purchase that never activated (closed tab, missed webhook). The
  app calls it on login and it reads the subscription id **from the profile**, so the client cannot
  point it at someone else's subscription.
- The frontend uses `result.plan` returned by the server instead of the plan it clicked.

### "If the user pays, do they get the plan?"

Yes — there are three independent paths, and any one of them is enough:

1. **onApprove** → `activate-subscription` (normal path, same request the PayPal button makes).
2. **PayPal webhook** → `BILLING.SUBSCRIPTION.ACTIVATED` reaches the Worker, which re-reads the
   subscription from PayPal and applies it. Enable these events in
   developer.paypal.com → your app → Webhooks: `BILLING.SUBSCRIPTION.ACTIVATED`,
   `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
   `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`,
   pointed at `https://<your-worker>/payment/webhook`.
3. **Next login** → `reconcile-subscription` re-reads the stored subscription and fixes the plan.

If a payment ever succeeds while the plan cannot be identified, the subscription is still recorded on
the profile and the API returns 422 with a "your payment went through" message — so support (or the
next reconcile once you set the plan IDs) can finish it without the user paying twice.

**You must set** (Worker secrets): `PAYPAL_STUDENT_PLAN_ID`, `PAYPAL_PRO_PLAN_ID`,
`PAYPAL_ELITE_PLAN_ID`, `PAYPAL_WEBHOOK_ID`. Without the plan IDs it still works (name/price
matching), but set them — it's the difference between "should work" and "provably correct".

---

## 2. Users could change their own plan

**Before:** `CREATE POLICY "Users update own profile" ... FOR UPDATE USING (auth.uid() = id)` —
row-level only, so any column including `plan` was writable via the public Supabase API.
(That file also used `CREATE POLICY IF NOT EXISTS`, which is not valid Postgres, so some policies
silently never existed.)

**Now:** run `supabase_migration.sql` in the SQL Editor (it is idempotent, safe to re-run):

- the policy gets a `WITH CHECK (auth.uid() = id)` so a row can't be re-pointed at another user;
- a `BEFORE INSERT OR UPDATE` trigger, `protect_profile_billing_columns`, raises `42501` if a
  non-service-role request touches `plan`, `paypal_subscription_id`, `subscription_*`,
  `current_period_end`, `paypal_order_id` or `plan_activated_at`;
- a new user-created profile may not start on a paid plan;
- a partial unique index on `paypal_subscription_id` stops one subscription being used by many accounts;
- new `paypal_plans` table (RLS on, no policies = service role only);
- `otp_codes.attempts` column, plus a `cleanup_expired_otps()` helper.

Regular profile edits (name, avatar, XP, streak) are unaffected.

**Verify after running** (also at the bottom of the SQL file):

```sql
SELECT tgname FROM pg_trigger WHERE tgname = 'protect_profile_billing';
SELECT indexname FROM pg_indexes WHERE indexname = 'profiles_paypal_subscription_uidx';
SELECT paypal_subscription_id, count(*) FROM profiles
WHERE paypal_subscription_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;   -- must be 0 rows
```

If the unique index says it was skipped, there are already duplicate subscription rows — clean them
up and re-run. Then open **Advisors → Security Advisor** in the dashboard.

---

## 3. The AI endpoint accepted too much input

**Before:** any `body.model`, feature gating bypassable by omitting `type` and sending `prompt`,
unbounded `text`/`history`, and limits only in a per-isolate `Map`.

**Now** (`routes/ai-clean-lite.js`) — validated with **Zod** (`zod` added to `package.json`):

- The whole request body is parsed by `bodySchema`: `type` is a required enum of the six known
  features, so there is no free-form prompt path. Unknown keys are stripped.
- `body.model` is checked against `ALLOWED_MODELS`; anything else is a **400**, not a silent
  downgrade. The server's own fallback chain is a fixed list.
- Each feature has its own payload schema (`PAYLOAD_SCHEMAS`) with hard caps: source text 30k chars,
  chat message 4k, question/answer 2k, cards ≤ 60 with 1.2k per field, history ≤ 12 turns / 4k each /
  24k total. Card counts are clamped (not rejected) so the UI keeps working.
- History is normalised: only `user`/`model` roles survive, everything is flattened to text parts,
  non-text parts and system turns are dropped.
- A `content-length` guard rejects bodies over 256 KB before parsing.
- Prompts are built only from validated data — the model never sees a client-authored prompt string.
- Durable rate limiting via Cloudflare's Rate Limiting binding when `AI_RATE_LIMITER` is bound;
  the per-isolate Map in the Worker stays as a backstop only.

`tests/ai-validation.test.mjs` proves each of these (26 checks), including that a `{prompt: "..."}`
body with no `type` is rejected.

**Enabled in production.** `wrangler.toml` now declares two durable limiters (wrangler ≥ 4 required,
already bumped in `package.json`): `AI_RATE_LIMITER` (20 req/60 s per user) and `AI_IP_LIMITER`
(120 req/60 s per IP — generous because a school lab shares one NAT IP). Cloudflare's binding only
supports 10 s/60 s windows, so the per-user **daily** quota stays in Supabase, and the global daily
cap remains a best-effort in-memory backstop. Verified live: a parallel burst to `/ai` returns 429s,
and the guard now also matches bare `POST /ai` (the old `/ai/*` wildcard never matched it).

```toml
[[ratelimits]]
name = "AI_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 20, period = 60 }

[[ratelimits]]
name = "AI_IP_LIMITER"
namespace_id = "1002"
simple = { limit = 120, period = 60 }
```

The code degrades gracefully if a binding is absent (it falls back to the in-memory Map), so
deploying before configuring them is safe. The per-user daily quota needs no binding at all — it is
counted from the `ai_usage` table and is already durable.

---

## 4. The OTP attempt limit did nothing

`checkOtpAttempts()` returned `true` unconditionally. Now the counter lives on the
`otp_codes.attempts` row (service-role only, reset when a new code is issued):

- 5 wrong guesses burns the code and returns **429**;
- each wrong guess returns the remaining attempts;
- the hash comparison is now constant-time;
- the counter is durable — it does not reset with the Worker isolate.

---

## 5. AI output went into `innerHTML`

Added `renderAiMarkdown()`: it escapes the **entire** string first, then re-adds only our own
`<strong>` / bullet / heading `<div>` markup. Used by the tutor chat and the study guide.
Grading feedback (`result.feedback`, `card.a`) is escaped too, and `toast()` now builds its text with
`textContent` so server error strings can't inject either.

---

## 6. AI provider terms (not a code fix)

Read `AI-PROVIDER-COMPLIANCE.md` — it quotes the live terms and lays out the three options.
Short version, and a correction to what I said earlier:

- The Gemini API Additional Terms say you must be 18+, **and** that you may not use the APIs in an
  app "directed towards or is likely to be accessed by individuals under the age of 18".
- **Paying does not remove that age clause.** A paid tier fixes the data half (no training, DPA,
  logs for abuse only). It does not make a K-12 app compliant. I overstated that earlier.
- So: either make HeyMino an 18+ product and move to a paid tier, or move the K-12 product to a
  provider whose terms permit under-18 end users under a DPA. Until one of those happens, this item
  stays open no matter what the code does.

What this patch does contribute: `privacy.html` now discloses the AI sub-processor and that, on the
unpaid quota, prompts may be used for improvement and read by reviewers; `terms.html` states what is
sent to the provider and that minors need guardian consent. Those paragraphs are written for Gemini
today — update them when you switch.

---

## Deploy

```bash
npm test                     # 62 checks, no network
node --check routes/payment.js
npx wrangler deploy
```

Then run `supabase_migration.sql` in the Supabase SQL Editor (separate from the deploy; the Worker
keeps working either way, but item 2 is only closed once the SQL runs).

## Not covered here (deliberately)

- Deleting the 12 `public_fixed*` folders, 8 worker copies, 33 `__patch_*` and 40 deploy-trigger
  files — that's a `git rm` decision, and `worker.js` / `routes/ai.js` / `routes/admin.js` are stale
  wiring, not live code.
- SPA route redirects (`/decks` → `/?from=/decks`) hurting SEO.
- A real CI check (`wrangler deploy --dry-run`, `npm test`) on pull requests.
