// Unit tests for the payment authorization rules — no network, no real PayPal.
import { resolvePlanFromPayPal, applySubscriptionState, reconcileIfStale } from '/tmp/hey/routes/payment.js'

let failed = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}

// ── Minimal Supabase stub ─────────────────────────────────────────────────────
const NO_ROW = Symbol('no row')
function stubSb({ plan = 'free', bound = null, planMap = null, updates = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq: () => ({
              maybeSingle: async () => {
                if (table === 'paypal_plans') {
                  return { data: planMap ? { plan: planMap } : null, error: null }
                }
                return { data: { plan, paypal_subscription_id: bound }, error: null }
              },
              limit: () => ({ then: (r) => r({ data: bound ? [{ id: bound }] : [], error: null }) }),
            }),
          }
        },
        update(patch) {
          return {
            eq: async (column, value) => {
              updates.push({ patch, column, value })
              return { error: null }
            },
          }
        },
      }
    },
  }
}

// ── Plan resolution: never from the client ────────────────────────────────────
const env = { PAYPAL_STUDENT_PLAN_ID: 'P-STUDENT', PAYPAL_PRO_PLAN_ID: 'P-PRO' }

let p = await resolvePlanFromPayPal(stubSb(), env, { plan_id: 'P-STUDENT' })
check('plan resolved from configured PAYPAL_*_PLAN_ID', p === 'student', `got ${p}`)

p = await resolvePlanFromPayPal(stubSb({ planMap: 'elite' }), env, { plan_id: 'P-UNKNOWN' })
check('plan resolved from recorded paypal_plans row', p === 'elite', `got ${p}`)

p = await resolvePlanFromPayPal(stubSb(), {}, { plan_id: 'P-X', plan: { name: 'Thyroxeia AI — Pro Plan (Monthly)' } })
check('plan resolved from PayPal plan name', p === 'pro', `got ${p}`)

p = await resolvePlanFromPayPal(stubSb(), {}, {
  plan_id: 'P-X',
  plan: { billing_cycles: [{ pricing_scheme: { fixed_price: { currency_code: 'PHP', value: '280.00' } } }] },
})
check('plan resolved from PayPal recurring price', p === 'elite', `got ${p}`)

p = await resolvePlanFromPayPal(stubSb(), {}, { plan_id: 'P-SOMETHING-ELSE' })
check('unknown plan resolves to null (activation refused)', p === null, `got ${p}`)

// A price in another currency must NOT be matched.
p = await resolvePlanFromPayPal(stubSb(), {}, {
  plan_id: 'P-X',
  plan: { billing_cycles: [{ pricing_scheme: { fixed_price: { currency_code: 'USD', value: '110.00' } } }] },
})
check('foreign-currency price is not matched', p === null, `got ${p}`)

// ── applySubscriptionState ────────────────────────────────────────────────────
let updates = []
let applied = await applySubscriptionState(
  stubSb({ updates }), env, 'user-1', 'I-ACTIVE',
  { status: 'ACTIVE', plan_id: 'P-PRO', custom_id: 'user-1', billing_info: { next_billing_time: '2026-01-01T00:00:00Z' } }
)
check('active + resolved plan grants that plan', applied.plan === 'pro', `got ${applied.plan}`)
check('active + resolved plan writes plan to the profile', updates[0]?.patch.plan === 'pro', JSON.stringify(updates[0]?.patch))
check('active + resolved plan stores subscription binding', updates[0]?.patch.paypal_subscription_id === 'I-ACTIVE')
check('active + resolved plan stores period end', updates[0]?.patch.current_period_end === '2026-01-01T00:00:00Z')

updates = []
applied = await applySubscriptionState(
  stubSb({ plan: 'elite', updates }), {}, 'user-1', 'I-PAYER',
  { status: 'ACTIVE', plan_id: 'P-UNKNOWN', custom_id: 'user-1' }
)
check('active + unresolvable plan does not downgrade', !('plan' in updates[0].patch), JSON.stringify(updates[0].patch))
check('active + unresolvable plan keeps the current plan in the response', applied.plan === 'elite', `got ${applied.plan}`)
check('active + unresolvable plan still stores the binding', updates[0].patch.paypal_subscription_id === 'I-PAYER')

updates = []
applied = await applySubscriptionState(
  stubSb({ plan: 'pro', updates }), env, 'user-1', 'I-DEAD',
  { status: 'CANCELLED', plan_id: 'P-PRO', custom_id: 'user-1' }
)
check('cancelled subscription downgrades to free', updates[0]?.patch.plan === 'free', JSON.stringify(updates[0]?.patch))
check('cancelled subscription reports inactive', applied.active === false)

updates = []
applied = await applySubscriptionState(
  stubSb({ plan: 'pro', bound: 'I-NEW', updates }), env, 'user-1', 'I-OLD',
  { status: 'CANCELLED', plan_id: 'P-PRO', custom_id: 'user-1' }
)
check('stale webhook for an old subscription is ignored', applied.skipped === true)
check('stale webhook writes nothing', updates.length === 0, `${updates.length} update(s)`)

// ── Lazy expiry: non-payers must lose access ─────────────────────────────────
const future = new Date(Date.now() + 86400000).toISOString()
const past = new Date(Date.now() - 86400000).toISOString()

let r = await reconcileIfStale(stubSb(), env, 'u1', { plan: 'free', current_period_end: past })
check('free plan is never touched by the expiry check', r.plan === 'free' && r.changed === false)

r = await reconcileIfStale(stubSb(), env, 'u1', { plan: 'elite', current_period_end: null })
check('owner grant without a period end is left alone', r.plan === 'elite' && r.changed === false)

r = await reconcileIfStale(stubSb(), env, 'u1', { plan: 'pro', current_period_end: future })
check('still-paid period keeps the plan without calling PayPal', r.plan === 'pro' && r.changed === false)

r = await reconcileIfStale(stubSb(), env, 'u1', { plan: 'pro', current_period_end: past, paypal_subscription_id: null })
check('expired but no subscription id cannot be re-checked (no crash)', r.plan === 'pro' && r.changed === false)


// ── End-to-end of the downgrade branch, with PayPal stubbed (no network) ──────
const realFetch = globalThis.fetch
function stubPayPal(subscription, { fail = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (fail) throw new Error('network down')
    if (u.includes('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    if (u.includes('/v1/billing/subscriptions/')) return new Response(JSON.stringify(subscription), { status: 200 })
    throw new Error('unexpected fetch ' + u)
  }
}
const expired = new Date(Date.now() - 86400000).toISOString()

let cap1 = []
stubPayPal({ status: 'CANCELLED', plan_id: 'P-PRO', custom_id: 'u1' })
let r1 = await reconcileIfStale(stubSb({ plan: 'pro', updates: cap1 }), env, 'u1', { plan: 'pro', current_period_end: expired, paypal_subscription_id: 'I-DEAD' })
globalThis.fetch = realFetch
check('cancelled subscriber is downgraded to free', r1.plan === 'free' && r1.changed === true, JSON.stringify(r1))
check('downgrade writes plan=free', cap1[0]?.patch.plan === 'free', JSON.stringify(cap1[0]?.patch))

let cap2 = []
stubPayPal({ status: 'ACTIVE', plan_id: 'P-PRO', custom_id: 'u1', billing_info: { next_billing_time: '2099-01-01T00:00:00Z' } })
let r2 = await reconcileIfStale(stubSb({ plan: 'pro', updates: cap2 }), env, 'u1', { plan: 'pro', current_period_end: expired, paypal_subscription_id: 'I-LIVE' })
globalThis.fetch = realFetch
check('renewed subscriber keeps the plan', r2.plan === 'pro' && r2.changed === false, JSON.stringify(r2))
check('renewal refreshes the period end', cap2[0]?.patch.current_period_end === '2099-01-01T00:00:00Z', JSON.stringify(cap2[0]?.patch))

let cap3 = []
stubPayPal({ status: 'CANCELLED', plan_id: 'P-PRO', custom_id: 'someone-else' })
let r3 = await reconcileIfStale(stubSb({ plan: 'elite', updates: cap3 }), env, 'u1', { plan: 'elite', current_period_end: expired, paypal_subscription_id: 'I-OTHER' })
globalThis.fetch = realFetch
check('foreign subscription cannot downgrade you', r3.plan === 'elite' && cap3.length === 0)

let cap4 = []
stubPayPal(null, { fail: true })
let r4 = await reconcileIfStale(stubSb({ plan: 'elite', updates: cap4 }), env, 'u1', { plan: 'elite', current_period_end: expired, paypal_subscription_id: 'I-X' })
globalThis.fetch = realFetch
check('PayPal outage never downgrades a payer', r4.plan === 'elite' && cap4.length === 0)

console.log(failed === 0 ? '\nAll payment tests passed.' : `\n${failed} test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
