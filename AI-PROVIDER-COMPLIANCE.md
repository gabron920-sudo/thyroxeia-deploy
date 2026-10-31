# Item 6 — the AI provider terms (the one that is not a bug)

This is the only finding in Mark's review that cannot be closed by editing code. Below is what
Google's terms actually say (checked against the live document), why paying does **not** fix it, and
the three ways to close it. Everything here is a decision you make, not a patch I can apply.

## What the terms say (verbatim, Gemini API Additional Terms, effective 23 March 2026)

> **Age Requirements**
> You must be 18 years of age or older to use the APIs. You also will not use the Services as part
> of a website, application, or other service (collectively, "**API Clients**") that is directed
> towards or is likely to be accessed by individuals under the age of 18.

> **Unpaid Services → How Google Uses Your Data**
> When you use Unpaid Services … Google uses the content you submit to the Services and any
> generated responses to provide, improve, and develop Google products and services and machine
> learning technologies … human reviewers may read, annotate, and process your API input and output.
> **Do not submit sensitive, confidential, or personal information to the Unpaid Services.**

> **Paid Services → How Google Uses Your Data**
> When you use Paid Services … Google doesn't use your prompts … or responses to improve our
> products, and will process your prompts and responses in accordance with the Data Processing
> Addendum …

## The part I got wrong earlier, and you need to know

I told you a paid Vertex/Gemini tier would fix this. **It fixes the data half only.** Paying removes
training and human review, but the **Age Requirements** paragraph above is not part of the Unpaid vs
Paid distinction — it applies to the APIs generally: no 18- apps, and no apps *likely to be accessed*
by under-18s.

So as long as HeyMino says "K-12 students" and anyone can sign up, **no Gemini API tier is
compliant**, free or paid. This is not a settings toggle; it is the licence.

## Three ways to close it

| | What you change | Keeps K-12? | Effort | Notes |
|---|---|---|---|---|
| **A. Become an 18+ product** | Eligibility text, age gate at signup, marketing copy. Move to a **paid** Gemini tier for the no-training/DPA terms. | ❌ no | Smallest — no architecture change | Your current students include minors; this shrinks the market but is honest and fast. Good if your real users are senior-high/college/board-exam takers. |
| **B. Switch provider and stay K-12** | Replace the Gemini call with a provider whose terms permit under-18 users with parental consent, covered by a DPA. | ✅ yes | Medium — one function + a provider account | Verify the provider's *current* age and children's-data terms yourself before signing up (they differ and they change). Enterprise routes (cloud-hosted model APIs with a DPA) are the usual answer for K-12. |
| **C. Split the product** | 18+ "study" product on Gemini paid; K-12 product on the provider from B. | ✅ yes | Largest | Only worth it once both have real users. |

For B, shortlist to evaluate (check each provider's live terms — do not take my summary as the
contract): a cloud-hosted model API with a signed data processing addendum and child-directed app
guidance, rather than a consumer-facing API key. The pattern that matters is: DPA + no training +
explicit permission for under-18 end users + parental consent flow.

## What to change in the code (all of it is one place)

The AI route is already isolated, so switching provider is a contained change:

- `routes/ai-clean-lite.js` — one `fetch` to the model, plus `ALLOWED_MODELS`, `buildPrompt()` and
  the Zod schemas. Swapping provider means rewriting that single call and its response parsing;
  nothing else in the app knows which provider is used.
- `routes/ai-clean-lite.js` header comment + `SECURITY-FIXES.md` — update the provider name.
- `public_fixed12/privacy.html` §7 — the sub-processor list and the AI disclosure paragraph
  (already added, currently describing Gemini; edit when you switch).
- `public_fixed12/terms.html` §4 — "Data sent for AI processing" (already added).
- Signup already records `terms_accepted`, `terms_version`, `terms_accepted_at` in
  `user_metadata`, and the checkbox already carries the guardian-consent sentence. If you go with B,
  bump `terms_version` so existing users re-accept the new text.

If you want an enforceable age gate, the smallest useful version is: a required "I am 18 or older"
(or guardian-consent) declaration at signup, stored in `user_metadata`, plus a check in the AI route
that rejects users without it. Do that only *after* you pick A or B — otherwise you lock out your
current students for a rule you have not yet satisfied.

## What this means for Mark's email

He wrote: *"Before you grow, choose a provider and plan whose terms allow your users and keep
student data out of training."* That is exactly right, and it is the item he will check first on a
second read, because it takes one search to verify. If you send the repo back with the code fixes
but the app still advertises K-12 on the free Gemini quota, the rest of the work looks like it was
done without reading the sentence he wrote.

The defensible reply to him is one of:

- "HeyMino is now 18+; here is the eligibility clause and the age gate." **or**
- "We moved to <provider> under a DPA that permits under-18 users with parental consent; here is
  the policy page and the consent record we keep."

Either of those is a *fix*. "We'll look into it" is not.
