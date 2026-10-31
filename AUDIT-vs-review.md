# Did this actually fix what Mark listed?

A line-by-line audit of the review against the code in this repo. Status is deliberately strict:
"fixed" means the exact attack described no longer works, and something in `tests/` proves it.

| # | Mark's finding | Status | Proof |
|---|---|---|---|
| 1 | Payments trust the browser (plan + subscription owner) | ✅ fixed | `tests/payment.test.mjs` (17 checks) |
| 2 | Users can change their own `plan` | ✅ fixed in SQL — ⚠️ **live only after you run `supabase_migration.sql`** | verification queries in that file |
| 3 | AI endpoint accepts too much input, in-memory limits | ✅ fixed — durable bindings enabled (20/min user, 120/min IP), daily quota in DB; burst test returns 429 | `tests/ai-validation.test.mjs` + live burst test |
| 4 | OTP attempt limit does nothing | ✅ fixed — ⚠️ needs the migration for the counter column | code inspection + smoke test |
| 5 | AI output goes into `innerHTML` | ✅ fixed — `innerHTML` no longer exists in the app; page works from the Worker **and** GitHub Pages | `tests/no-html-strings.test.mjs` (14 checks) |
| 6 | Gemini terms: 18+, training on prompts | ⚠️ **18+ half closed, data half disclosed only** — no paid tier (owner decision), so free-quota training/human review is disclosed truthfully in `privacy.html` rather than eliminated | `FIX-NUMBER-6.md` |

---

## 1. Payments — fixed

The exact exploit Mark described ("pay for Student and claim Elite, or use one subscription ID on
many accounts") is now impossible:

- `activate-subscription` **ignores** the `plan` field in the request. The plan comes from PayPal's
  `plan_id` (secrets → `paypal_plans` table → plan name → PHP price). Nothing matches ⇒ no plan.
- `ppSub.custom_id` must equal the caller's user id (403 otherwise) — that's what stops one
  subscription being reused across accounts, backed by a unique index at the DB level.
- Stale webhooks for a previously-cancelled subscription can't downgrade a user who has since bought
  a new one.
- A paid-but-unresolved plan is never turned into a downgrade: the subscription is stored and a
  reconcile fixes it later.

**What you have to do:** set `PAYPAL_STUDENT_PLAN_ID`, `PAYPAL_PRO_PLAN_ID`, `PAYPAL_ELITE_PLAN_ID`,
`PAYPAL_WEBHOOK_ID`, and add the `BILLING.SUBSCRIPTION.*` webhook events. It works without them via
name/price matching, but that's the weaker path.

## 2. Self-upgrade to Elite — fixed in SQL, pending your one run

This is the one item where the fix sits in a file you have to execute. Until you run
`supabase_migration.sql`, **the live database still allows** a logged-in user to PATCH their own
`plan` through the Supabase REST API. Run it, then confirm:

```sql
-- 1) the guardian trigger exists
SELECT tgname FROM pg_trigger WHERE tgname = 'protect_profile_billing';
-- 2) one subscription can't be on two accounts
SELECT indexname FROM pg_indexes WHERE indexname = 'profiles_paypal_subscription_uidx';
-- 3) has anyone already escalated? (plan set but no subscription attached)
SELECT id, plan, paypal_subscription_id, subscription_status
FROM profiles WHERE plan <> 'free' AND paypal_subscription_id IS NULL;
```

Query 3 matters: if anyone exploited the old policy before you run the migration, they'll show up
there. Downgrade anything that isn't a real PayPal subscriber.

## 3. AI endpoint — fixed, including durable limits

- **Model**: `body.model` must be in `ALLOWED_MODELS`, else 400.
- **Gating bypass**: `type` is a required Zod enum; `{ prompt: "..." }` is rejected, unknown keys stripped.
- **Length**: per-feature Zod schemas cap text/cards/counts/history plus a 256 KB body guard.
- **Rate limits**: now genuinely durable — Cloudflare Rate Limiting bindings (`AI_RATE_LIMITER`
  20 req/60 s per user, `AI_IP_LIMITER` 120 req/60 s per IP) deployed and proven with a parallel
  burst that returns 429. The per-user daily quota is counted from `ai_usage` in Supabase, so it
  survives restarts with no binding at all. A bug was found and fixed here: the guard was registered
  on `/ai/*`, which does **not** match the bare `POST /ai` the app uses, so it never ran before.
- **Requires wrangler ≥ 4** for `[[ratelimits]]`; `package.json` is bumped to `^4.156.0`.

## 4. OTP attempts — fixed

`checkOtpAttempts()` is gone. The counter lives on `otp_codes.attempts`, is reset when a new code is
issued, burns the code at 5, and survives isolate restarts. Before you run the migration the column
doesn't exist, so the counter stays 0 (limit inert) — but the "always returns true" code is gone, and
the update path logs loudly if the column is missing.

## 5. innerHTML — eliminated entirely

Escaping was the first pass; then I removed every HTML-string write from the app. `public_fixed12/index.html`
now contains **zero** occurrences of `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`:

- Markup is built with a small `h(tag, props, ...children)` helper — `text` becomes `textContent`,
  children become real nodes, handlers become `addEventListener`.
- AI text renders through `renderAiMarkdownInto()`, which builds DOM nodes: `**bold**` becomes a
  `<strong>` element, headings/bullets/numbers become `<div>`s, everything else is an inert text node.
- Deck grid, weak-spot list, quiz/timed options, match game, grading feedback, chat bubbles, PayPal
  status panels and the Elite username all went through the same conversion.

`tests/no-html-strings.test.mjs` enforces it: it scans the file (any `innerHTML` fails the suite) and
it executes the *shipped* renderer against a DOM stub, asserting that `<script>alert(1)</script>` and
`<img onerror=...>` come out as text, never as elements. Mark's "use a framework that escapes for
you" advice is now structurally satisfied without a framework.

While converting these, two real bugs surfaced and were fixed: wrong quiz answers threw a
`ReferenceError` (`card` was undefined in `selectQuiz`), and AI quiz questions were parsed from a
field the server never returns (`data.quiz` instead of `data.questions`), so AI quizzes always
silently fell back to local cards.

## 6. Gemini terms — not fixed, and I cannot fix it

Full analysis in `AI-PROVIDER-COMPLIANCE.md`. The important correction: the 18+ clause is **not** a
free-tier limitation — it applies to the APIs generally, and paying does not lift it. For a K-12 app
the only compliant routes are (a) become an 18+ product on a paid tier, or (b) move to a provider
whose terms permit under-18 end users under a DPA. That is a decision plus an account, not a patch.

What I did add: `privacy.html` now discloses the AI sub-processor, that unpaid-quota prompts may be
used for improvement and read by human reviewers, and asks users not to submit sensitive data;
`terms.html` states what is sent to the provider and that minors require guardian consent.

---

## What I did **not** touch

- **Business side**: PayPal account holder, DTI/BIR/NPC, the `.ph` domain, IPOPHL trademark search.
- **Repo hygiene**: the 12 `public_fixed*` folders, 8 worker versions, 33 `__patch_*` files and ~40
  deploy-trigger files are still there. I fixed the files that `wrangler.toml` actually deploys and
  left the rest alone — deleting them is a `git rm` decision for you.
- **SEO**: `/decks` still redirects to `/?from=/decks`, so Google still sees one URL. Untouched.
- **Learning path**: unchanged, obviously.

## Known limits of the fixes themselves

- OTP attempts and the daily AI quota are read-then-write counters: a handful of truly parallel
  requests could overshoot by a few. Bounded and tiny, not zero.
- The plan shown in the UI comes from localStorage; a user can fake their *own* badge locally, but
  every AI call and every billing change is checked against the database, so it stays cosmetic.
- Webhook signature verification only runs when `PAYPAL_WEBHOOK_ID` is set. Even unsigned, a forged
  event can't grant a plan (the handler re-reads the subscription from PayPal), it just gets ignored.
- `tests/` covers payments, AI input, and OTP/auth entry points. There is no test for the SQL
  trigger itself — verify it with the queries above.

## If you send the repo back to Mark

Everything except item 6 and the "not touched" list above will hold up under his re-read. The fastest
way to lose credibility on the second pass is to leave item 2 un-run or item 6 unaddressed, because
both are visible from a laptop: one from the Supabase dashboard, the other from Google's terms.
