# Where these files go

This folder is a copy of your repo with the fixes already applied — same folder layout as
`gabron920-sudo/thyroxeia-deploy`. Copy each file over the one at the same path, or unzip the
`heymino-security-fixes.zip` over a fresh clone.

```
worker-clean-lite.js          → worker-clean-lite.js          (your wrangler.toml "main")
routes/payment.js             → routes/payment.js
routes/ai-clean-lite.js       → routes/ai-clean-lite.js
routes/auth-email.js          → routes/auth-email.js
supabase_migration.sql        → supabase_migration.sql        (run in Supabase SQL editor)
public_fixed12/index.html     → public_fixed12/index.html     (your wrangler.toml [assets] dir)
public_fixed12/privacy.html   → public_fixed12/privacy.html   (AI sub-processor disclosure added)
public_fixed12/terms.html     → public_fixed12/terms.html     (AI data + minors clause added)
.env.example                  → .env.example
package.json                  → package.json
tests/                        → tests/                         (new folder: 62 checks)
SECURITY-FIXES.md             → SECURITY-FIXES.md              (what changed and why)
AUDIT-vs-review.md            → AUDIT-vs-review.md             (Mark's 6 items, status + proof)
AI-PROVIDER-COMPLIANCE.md     → AI-PROVIDER-COMPLIANCE.md      (item 6: the decision you must make)
```

Only these files changed. Nothing else in the repo was touched: `worker.js`,
`routes/ai.js`, `routes/admin.js` and the `public_fixed*` / `__patch_*` / `__deploy_trigger*`
files are untouched (they are dead copies — see the note at the end).

## Order of operations

1. **Copy the files in** and check the diff:
   ```bash
   git diff --stat
   git checkout -b security-fixes
   git add -A && git commit -m "Harden payments, RLS, AI input, OTP limits, and AI output escaping"
   ```
2. **Run the tests** (no network needed):
   ```bash
   npm install          # zod is a new dependency
   npm test             # 62 checks
   ```
3. **Set Worker secrets** before deploying:
   ```bash
   npx wrangler secret put PAYPAL_STUDENT_PLAN_ID
   npx wrangler secret put PAYPAL_PRO_PLAN_ID
   npx wrangler secret put PAYPAL_ELITE_PLAN_ID
   npx wrangler secret put PAYPAL_WEBHOOK_ID
   ```
   The plan IDs are the `P-...` IDs from developer.paypal.com → Products & Plans. Without them
   the server can still identify a plan from PayPal's plan name and price, but the IDs are the
   reliable path.
4. **Deploy**: `npx wrangler deploy`.
5. **Enable the PayPal webhook events** (developer.paypal.com → your app → Webhooks, URL
   `https://<your-worker>/payment/webhook`): `BILLING.SUBSCRIPTION.ACTIVATED`, `.UPDATED`,
   `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`, `.PAYMENT.FAILED`. This is the backstop that grants a
   plan even if the buyer closes the tab, and `PAYPAL_WEBHOOK_ID` is what makes the Worker verify
   the signature.
6. **Run `supabase_migration.sql`** in Supabase → SQL Editor. It is idempotent, so re-running is
   safe. Then run the verification queries at the bottom of that file, and check
   Dashboard → Advisors → Security Advisor.

Steps 4 and 5 are independent — deploy and SQL can happen in either order without breaking the app
(the code tolerates the new column/table being absent yet).

## Optional: durable rate limiting

`routes/ai-clean-lite.js` uses Cloudflare's Rate Limiting binding when it exists and quietly falls
back when it doesn't. To turn it on:

```bash
npm i -D wrangler@latest
```

```toml
[[ratelimits]]
name = "AI_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 30, period = 60 }
```

## What still needs a human

- **AI provider terms** (review item 6): the Gemini free tier is 18+ and may train on prompts.
  That is a provider/plan decision, not a code change — see section 6 of `SECURITY-FIXES.md`.
- **PayPal business account** should be held by a parent/guardian if you are under 18.
- **Repo cleanup**: `worker.js`, `routes/ai.js`, `routes/admin.js`, the 12 `public_fixed*` folders,
  the `worker-clean*.js` copies, 33 `__patch_*` files and ~40 `__deploy_trigger_*.txt` files are
  not part of the live Worker. Git is your history — delete them in one commit so nobody
  (including the next AI agent) edits the wrong file. That is why the fixes were applied to
  `worker-clean-lite.js` and `public_fixed12/`, the paths `wrangler.toml` actually deploys.
