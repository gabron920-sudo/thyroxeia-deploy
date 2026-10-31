# Number 6 — the actual runbook

> **Status: Option A, without the paid tier (decided).** There is no card, so the Gemini key stays on
> the free quota. What that means: the **age rule is satisfied** (the app is 18+ with an enforced gate),
> but the **data rule is not** — on the free quota Google may use prompts to improve its products and
> human reviewers may read them. `privacy.html` now says exactly that, so the app is honest rather
> than overclaiming. If a paid tier ever becomes possible, re-apply step A1 and the paid wording.
>
> **Original status note:** Option A chosen. The code side of A is already applied in this repo (see
> `GUARDIAN-ACCOUNTS.md` for what changed and who owns which account). What remains is the
> **account work**, which only your grandpa can do: link Google Cloud billing, own the PayPal
> business account and the domain. Enable billing **before** deploying the updated privacy page —
> it states that Google processes requests as a paid service.
>
> Reminder: using a guardian's accounts does not let you keep a K-12 audience. Option A means the
> app itself is 18+, so classmates cannot sign up. To bring them back you'd switch provider (B).

Item 6 is not a bug, so there is no patch. It is one decision, and then about an hour of work.
Pick **A** or **B** below and follow the steps in order. `AI-PROVIDER-COMPLIANCE.md` has the quoted
terms and the reasoning; this file is just what to click and what to type.

> **Do this today, even before deciding:** the current site says "K-12 students" while running on the
> Gemini API, and Google's terms forbid apps "likely to be accessed by individuals under 18". That is
> a live gap. The 30-minute version of option A (steps A1–A4) closes it immediately; you can still
> move to the K-12 provider afterwards.

---

## Option A — make HeyMino an 18+ product (fastest, keeps all your code)

### A1. Move to the paid tier (fixes the data half)
1. Open **https://aistudio.google.com/apikey** and check which Cloud project your keys belong to.
2. Open **https://console.cloud.google.com/billing** and link an active billing account to that
   project. Per Gemini's terms, "your access to Gemini API is a Paid Service only when accessing the
   API through a Cloud Project associated with an active billing account."
3. Confirm in the AI Studio key page or Cloud console that the project shows **billing enabled**.
   From that point Google does not use your prompts to improve its products and does not send them to
   human reviewers.
4. Add a spend cap so a spike can't run away: Cloud console → Billing → **Budgets & alerts**.

Nothing changes in the code — the same keys now bill.

### A2. Change the eligibility wording (`public_fixed12/terms.html` §1)
Replace the K-12 sentence:

```html
<li>HeyMino is an educational study platform intended for students from kindergarten through senior high school (K-12).</li>
```

with:

```html
<li>HeyMino is an educational study platform for users aged 18 and over.</li>
```

Keep the rest of §1 (parental consent) — it still applies to 18-year-olds in some jurisdictions, and
it does no harm.

### A3. Add the age gate at signup (`public_fixed12/index.html`)
The signup form already has a consent checkbox (`#signup-agree`). Add an age declaration next to it,
inside the same `<form>` (after the existing label, around line 443):

```html
<label style="display:flex;gap:10px;align-items:flex-start;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:12px;margin:0 0 14px;cursor:pointer">
  <input type="checkbox" id="signup-age18" style="margin-top:2px;accent-color:#ef4444" />
  <span class="text-xs" style="color:var(--text2);line-height:1.5">I confirm I am <strong>18 years of age or older</strong>.</span>
</label>
```

In the signup handler (right after the existing `signup-agree` check, ~line 992):

```js
if (!document.getElementById('signup-age18')?.checked) { toast('You must be 18 or older to create an account.', 'error'); return }
```

And record it with the other consents in the `signUp` call (~line 1006), so there is an audit trail
in Supabase's `user_metadata`:

```js
data: { first_name: first, last_name: last, full_name: `${first} ${last}`,
        terms_accepted_at: new Date().toISOString(), terms_version: '2026-11',
        terms_accepted: true, age_18_plus: true, age_declared_at: new Date().toISOString() },
```

### A4. Remove K-12 from the marketing copy
Search the repo for the phrase and update each hit:

```bash
grep -rn "K-12\|K12\|kindergarten" public_fixed12/ index.html
```

Also update the `<title>` / `<meta name="description">` in `public_fixed12/index.html` if they mention
K-12.

### A5. Update the policy pages to the paid-tier wording
In `public_fixed12/privacy.html`, the "AI processing in detail" note currently says Google may use
prompts on the unpaid quota and that reviewers may read them. Replace that sentence with:

> Google processes these requests as a paid service: it does not use your prompts or the generated
> responses to improve its products, and handles them under its data processing terms.

Then bump the "last updated" date on both pages.

### A6. Bump `terms_version`
Change `terms_version: '2026-11'` (A3) and the visible "last updated" line in `terms.html` so existing
users re-accept.

### A7. Verify
1. Sign up in a private window without ticking the age box → must be blocked.
2. Sign up with it ticked → check Supabase → Authentication → user → `user_metadata.age_18_plus: true`.
3. Make one AI request and check Cloud console → Billing shows usage (proof it's a paid service).
4. Re-read the Age Requirements in `AI-PROVIDER-COMPLIANCE.md` against what the site now claims:
   nothing on the site should promise K-12 support.

**Done when:** the site says 18+, signup enforces it, and the API project has active billing.

---

## Option B — keep K-12, switch provider (correct if your users are really minors)

### B1. Choose the provider
Requirements to check in their **live** terms, in writing:
- under-18 end users permitted, with parental consent for minors;
- a signed **DPA** (data processing addendum) available on your plan;
- **no training** on your prompts/responses for the tier you'll use;
- data residency / retention you can live with.

Do not sign up on a consumer free tier and assume it's fine — that is exactly the mistake item 6 is
about. Ask their sales/support for the DPA before you build.

### B2. Get the credentials and put them in secrets
```bash
npx wrangler secret put AI_API_KEY        # new provider's key
npx wrangler secret put AI_BASE_URL       # e.g. the provider's v1 endpoint
npx wrangler secret put AI_MODEL          # the model id you were approved for
```

### B3. Replace the provider call — it is one block
Everything Gemini-specific lives in `routes/ai-clean-lite.js`:

- `ALLOWED_MODELS` / `FALLBACK_MODELS` (top of file) → your provider’s model ids.
- `getGeminiKeys(env)` → read the new secret(s).
- the `outer: for (const apiKey of shuffledKeys) { … }` loop inside `app.post('/')` → one `fetch` to
  the new provider, and the response parsing line:

```js
const text = aiJson?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.'
```

That single line is where a different API shape shows up (e.g. `choices[0].message.content`). Prompts,
validation, quotas, feature gating, ownership and errors all stay exactly as they are — nothing else
in the app knows which provider you use.

### B4. Update `.env.example` and the comments
Replace the `GEMINI_API_KEY*` block and the header comment in `routes/ai-clean-lite.js` so the next
person (or AI agent) doesn't "fix" the wrong provider back in.

### B5. Update the policy pages
- `privacy.html` §7: replace **Google (Gemini API)** with the new processor name, and rewrite the
  note to state the actual data terms (no training, DPA, retention).
- `terms.html` §4: same provider name swap.
- Bump the "last updated" date and `terms_version`, so users re-accept.

### B6. Keep the consent trail you already have
Signup already stores `terms_accepted`, `terms_version`, `terms_accepted_at`, and the checkbox already
carries the guardian-consent sentence. That is the record a school or regulator will ask for.

### B7. Verify
1. `npm test` → still 62/62 (provider swap doesn't touch the schemas).
2. One real generation per feature (cards, quiz, chat, guide, grading) → correct output.
3. Confirm the provider dashboard shows the requests under **your** account, not a personal one.
4. Re-read the provider's age clause one more time and check the privacy page matches it word for word
   on the important parts: who the processor is, what is sent, whether it trains.

**Done when:** the app can truthfully say "under-18 users are permitted by our provider under a DPA",
and the privacy page names that provider.

---

## What to send Mark when you've done it

One of these two sentences, plus the link:

- **A:** "HeyMino is now 18+; here's the eligibility clause and the signup age gate, and the API is on
  a paid tier with a DPA."
- **B:** "We moved to <provider> under a DPA that allows under-18 users with parental consent; here's
  the privacy page and the consent we record at signup."

Both are verifiable in a minute, which is the point. "We'll look into it" is the one answer that keeps
item 6 open.
