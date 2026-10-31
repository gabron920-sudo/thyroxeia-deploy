# PayPal: what you already have vs what's still missing

`PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` are **2 of the 6** settings the subscription flow uses.
The other four are what make a plan actually resolvable after someone pays.

| Secret | What it is | Format | Do you have it? |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | App credentials | `Ae...` | ✅ yes |
| `PAYPAL_CLIENT_SECRET` | App credentials | `EL...` | ✅ yes |
| `PAYPAL_STUDENT_PLAN_ID` | The **plan** you sell at ₱110 | `P-...` | ❓ |
| `PAYPAL_PRO_PLAN_ID` | The plan at ₱220 | `P-...` | ❓ |
| `PAYPAL_ELITE_PLAN_ID` | The plan at ₱280 | `P-...` | ❓ |
| `PAYPAL_WEBHOOK_ID` | Signature check for `/payment/webhook` | `WH-...` | optional but recommended |

Client ID/secret only let the Worker *talk* to PayPal. They do not tell it **which plan the buyer
paid for** — that's the plan IDs, and that's the whole point of the fix (the server must derive the
plan from PayPal, never from the browser).

## 1. Check what's actually set (30 seconds)

```bash
npx wrangler secret list
```

That prints names only (never values). If `PAYPAL_STUDENT_PLAN_ID` etc. aren't in the list, they're
not set — and you're currently relying on the weaker fallback (plan name / price matching, plus
whatever the Worker recorded in `paypal_plans`).

Also confirm the mode:

```bash
npx wrangler secret list | grep -i paypal
npx wrangler secret put PAYPAL_MODE      # value: live  or  sandbox
```

**Live credentials only work against `api-m.paypal.com`; sandbox credentials only against
`api-m.sandbox.paypal.com`.** A live Client ID with `PAYPAL_MODE=sandbox` (or the reverse) fails at
the first token request, and the app just says "Could not verify subscription with PayPal".

## 2. Get the three plan IDs

1. **https://developer.paypal.com/dashboard** → sign in as the business account (**your grandpa's**,
   see below) → toggle **Live** (top right) for production plans.
2. **Products & Plans** → create the product (e.g. "HeyMino") if it doesn't exist.
3. Under that product create three **Plans**, monthly, PHP:
   - "Thyroxeia AI — Student Plan (Monthly)" — ₱110.00
   - "Thyroxeia AI — Pro Plan (Monthly)" — ₱220.00
   - "Thyroxeia AI — Elite Plan (Monthly)" — ₱280.00

   The names matter: the server can fall back to the plan *name* if a plan ID isn't configured, so
   use these exact strings (they're `PLAN_LABELS` in `routes/payment.js`).
4. Click each plan → copy its **Plan ID** (`P-...`).
"> Use the **Live** plans for live credentials. Sandbox plans have their own separate P-… IDs."

```bash
npx wrangler secret put PAYPAL_STUDENT_PLAN_ID   # paste P-...
npx wrangler secret put PAYPAL_PRO_PLAN_ID
npx wrangler secret put PAYPAL_ELITE_PLAN_ID
```

## 3. Webhook (recommended)

1. developer.paypal.com → your app → **Webhooks** → **Add webhook**.
2. URL: `https://<your-worker>/payment/webhook`
3. Events:
   `BILLING.SUBSCRIPTION.ACTIVATED`, `.UPDATED`, `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`,
   `.PAYMENT.FAILED`
4. Copy the **Webhook ID** (`WH-...`):

```bash
npx wrangler secret put PAYPAL_WEBHOOK_ID
```

Without it, the endpoint still re-checks every event with PayPal's API (so a forged event can't grant
a plan) — you just don't get signature verification, and a payment that completes while the buyer's
tab is closed won't be picked up until they next log in (`reconcile-subscription`).

## 4. Verify from inside the Worker

There's now an owner-only endpoint that reports booleans and actually tests the credentials:

```bash
# get your access token: app → DevTools → Application → Local Storage →
# key starting with "sb-" and ending in "-auth-token" → copy the "access_token" value
curl -s https://<your-worker>/admin/payment-config \
  -H "Authorization: Bearer <access_token>" | python3 -m json.tool
```

You'll get something like:

```json
{
  "mode": "live",
  "credentials": { "ok": true, "status": 200 },
  "planIds": { "student": true, "pro": true, "elite": false },
  "hasWebhookId": true,
  "readyForPayments": false,
  "missing": ["PAYPAL_ELITE_PLAN_ID"]
}
```

`credentials.ok: true` means the secret pair works against that mode. `readyForPayments: true` means
a buyer can actually be upgraded.

## 5. End-to-end test before real money

1. Create **sandbox** app credentials + sandbox plans, set `PAYPAL_MODE=sandbox` and the three
   sandbox plan IDs.
2. Deploy, sign in with a test account, buy Student with a sandbox buyer.
3. Expect: plan becomes `student` in Supabase; `/payment-config` shows sandbox.
4. Switch everything back to live (`PAYPAL_MODE=live`, live client id/secret, live plan IDs).

## 6. The account-ownership bit (this is the part secrets can't fix)

Those client credentials were created inside **some** PayPal account. If that account is yours, the
contract is still with a minor — which is exactly what Mark flagged. Under Option A they should be
reissued in **your grandpa's** PayPal Business account:

1. He creates/uses PayPal Business (his name, his bank, his ID for verification).
2. Create a **new app** there (his developer dashboard) → new Client ID/Secret.
3. Add you under *Settings → Manage users* so you can work without owning the money.
4. Replace the Worker secrets with the new pair. The old ones stop working — which is the point.

Secrets you set with `wrangler secret put` are read at runtime: **no redeploy needed**, but the next
request uses the new value, so update them together (client id + secret + plan IDs) to avoid a window
where the pairs mismatch.

## 7. If you leave the plan IDs unset

It still works, via the fallbacks in `resolvePlanFromPayPal()`:

1. `PAYPAL_*_PLAN_ID` secrets → 2. `paypal_plans` table (written by the Worker when it creates a plan
on demand) → 3. the plan **name** we gave PayPal → 4. the recurring **price** in PHP.

The fallbacks are server-derived, so the security hole stays closed either way. But path 2 needs the
migration (`paypal_plans` table) to exist, and on-demand plan creation litters your PayPal account
with a new product+plan per attempt. Setting the three IDs is the clean, boring, correct option.
