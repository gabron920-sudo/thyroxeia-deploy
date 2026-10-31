# Using your grandpa's accounts (this is the right instinct — with one catch)

There are **two separate "18+" rules** in play, and they are not the same:

| | Who must be 18+ | Does grandpa solve it? |
|---|---|---|
| **1. The account / billing owner** — Google Cloud billing, PayPal, domain, business registration | The adult who signs the contracts | ✅ **Yes.** And it's required, because you're a minor: contracts with minors are voidable, and PayPal requires an 18+ account holder. |
| **2. The app's audience** — who is allowed to *use* HeyMino | The users of the app | ❌ **No.** Google's clause is about the app being "directed towards or likely to be accessed by individuals under the age of 18". Whose credit card pays for the API doesn't change who logs in. |

So: for **Option A**, your grandpa holds the accounts *and* the app is 18+. Both. Using his billing
does **not** let you keep the K-12 audience — that would still be the same violation, just with a
different payer. Your classmates cannot sign up under Option A; that is exactly what A means.

(If you want your classmates back, that's Option B — a provider whose terms permit under-18 users
with parental consent — and it still needs grandpa for the contracts.)

## What grandpa should own, and what you keep

The clean split: **he owns the legal/billing surface, you keep the technical work.**

### Google Cloud (this is what makes the Gemini API a Paid Service)
1. Grandpa signs in with **his own Google account** (not yours).
2. **https://console.cloud.google.com/billing** → *Create billing account* → add **his** card.
3. Create a project (or use your existing one) and link that billing account to it:
   *Billing → Account management → Link a billing account*.
4. Add **you** as a project member so you can still create API keys and see logs:
   *IAM & Admin → Grant access* → your Google account → role **Editor** (not Billing Administrator —
   that stays with grandpa).
5. Create the Gemini API key in that project (**https://aistudio.google.com/apikey**, select the
   project) and store it only as a Worker secret:
   `npx wrangler secret put GEMINI_API_KEY`.
6. Grandpa sets a **budget alert** (*Billing → Budgets & alerts*, e.g. $10) so nothing runs away.

**Never** put the key in the repo, and don't let grandpa's password live in your notes app.

### PayPal (Mark's point: an adult must own the payment account)
1. Grandpa creates/uses a **PayPal Business** account in his name (needed for subscriptions and for
   the business details PayPal will ask for).
2. *Settings → Manage users* → invite **you** with the permissions you need (usually "Customer
   service / disputes" read, no payout access).
3. The **Client ID / Secret** go into Worker secrets (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`).
   The money lands in **his** account — agree in writing with him what happens to it (see below).

### Domain
1. Register `heymino.ph` (or `.com`) under **grandpa's registrar account**, registrant = him, and
   turn on WHOIS privacy.
2. Add it to your Cloudflare account as a custom domain for the Worker. Cloudflare's billing can be
   his card; account access can stay yours.

### Business registration (only when you're ready to formalise)
A minor generally can't register a sole proprietorship in their own name. Options: grandpa registers
it (DTI → BIR → then **NPC** registration as a personal information controller, which your privacy
policy already implies by citing RA 10173), or you wait until 18 and keep things small until then.

### The written bit (10 minutes, worth it)
One page, signed by both of you: *who owns the PayPal balance, who pays the Google bill, who can
close the accounts, and what happens if the business stops.* If money and identity are in his name,
the default legal answer is that it's his — a short note avoids family friction later.

## What I already changed in the code for Option A

- `terms.html` §1 — eligibility is now "users aged 18 and over"; the K-12 sentence and the
  under-18/under-13 consent bullets are replaced with "do not create an account if you are under 18".
- `privacy.html` §3 — same 18+ statement (accounts belonging to minors are closed), and §7's AI note
  now describes Google as a **paid** processor (no training, DPA).
- `index.html` — a required **"I am 18 or older"** checkbox on signup; the handler blocks account
  creation without it; the declaration is recorded in Supabase `user_metadata` as
  `age_18_plus: true` + `age_declared_at`, and `terms_version` is bumped to `2026-11`.

**Publish order matters:** the privacy page now says Google treats requests as a paid service. That
is only true after grandpa links billing (Google Cloud step above). Enable billing **first**, then
deploy. The page carries an HTML comment reminding you of this.

## If you later do Option B (to bring classmates back)

Revert exactly four things:
1. `terms.html` §1 → "for users aged 13 and over; under-18 requires parent/guardian consent"
   (the previous wording is in git history).
2. `privacy.html` §3 → the guardian-consent bullets.
3. `index.html` → replace the `signup-age18` checkbox with a guardian-consent declaration, keep
   recording it in `user_metadata`.
4. Bump `terms_version` so everyone re-accepts.

Then follow `FIX-NUMBER-6.md` Option B for the provider swap. Nothing in the payments, AI-validation
or database work changes.
