/**
 * /payment — PayPal subscription billing
 * 
 * POST /payment
 * Requires: Authorization: Bearer <supabase_jwt>
 * Body: { action, payload }
 * 
 * Actions:
 *   create-subscription     → creates PayPal subscription, returns subscriptionId
 *   activate-subscription   → verifies subscription with PayPal, updates Supabase
 *   check-subscription      → checks current subscription status
 * 
 * POST /payment/webhook     → PayPal webhook handler (no auth needed)
 *   Verifies subscription directly with PayPal before updating Supabase.
 *   If inactive/cancelled/suspended/expired, downgrades user to free.
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

// ── Auth helper ────────────────────────────────────────────────────────────────
async function getAuthUser(c) {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return { error: 'Authentication required.', status: 401 }
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY)
    return { error: 'Auth service not configured.', status: 500 }
  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return { error: 'Invalid or expired session. Please log in again.', status: 401 }
  return { user, sb }
}

// ── PayPal helpers ─────────────────────────────────────────────────────────────
function getPayPalBase(env) {
  return (env.PAYPAL_MODE === 'sandbox')
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'
}

async function getPayPalToken(env) {
  const base = getPayPalBase(env)
  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
    },
    body: 'grant_type=client_credentials',
  })
  if (!resp.ok) {
    const t = await resp.text()
    throw new Error(`PayPal auth failed ${resp.status}: ${t.substring(0, 200)}`)
  }
  return (await resp.json()).access_token
}

async function ppFetch(env, path, options = {}) {
  const base  = getPayPalBase(env)
  const token = await getPayPalToken(env)
  const resp  = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  const text = await resp.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!resp.ok) {
    const err = new Error(`PayPal API error ${resp.status}: ${JSON.stringify(body).substring(0, 300)}`)
    err.status = resp.status
    err.body   = body
    throw err
  }
  return body
}

// ── Plan prices in PHP ─────────────────────────────────────────────────────────
const PLAN_PRICES = {
  student: '110.00',
  pro:     '220.00',
  elite:   '280.00',
}

const PLAN_LABELS = {
  student: 'Thyroxeia AI — Student Plan (Monthly)',
  pro:     'Thyroxeia AI — Pro Plan (Monthly)',
  elite:   'Thyroxeia AI — Elite Plan (Monthly)',
}

const PLAN_NAMES = {
  student: 'Student',
  pro:     'Pro',
  elite:   'Elite',
}

// ── Plan resolution ───────────────────────────────────────────────────────────
// The plan a user receives is ALWAYS derived from PayPal's own records.
// The client's `plan` field is never trusted, so paying for Student can never
// activate Elite, and one subscription can never be reused across accounts.
function envPlanIdMap(env) {
  const map = new Map()
  for (const plan of Object.keys(PLAN_PRICES)) {
    const id = env[`PAYPAL_${plan.toUpperCase()}_PLAN_ID`]
    if (id) map.set(id, plan)
  }
  return map
}

async function resolvePlanFromPayPal(sb, env, ppSub) {
  const planId = ppSub?.plan_id
  if (!planId) return null

  // 1) Plans configured explicitly as Worker secrets.
  const fromEnv = envPlanIdMap(env).get(planId)
  if (fromEnv) return fromEnv

  // 2) Plans created on demand by this Worker, recorded server-side (service role only).
  try {
    const { data } = await sb.from('paypal_plans').select('plan').eq('plan_id', planId).maybeSingle()
    if (data?.plan && PLAN_PRICES[data.plan]) return data.plan
  } catch (e) {
    console.warn('[Payment] paypal_plans lookup failed:', e?.message || e)
  }

  // 2b) The plan name we gave PayPal when creating it (also PayPal's own record).
  const planName = ppSub?.plan?.name || ''
  if (planName) {
    const byName = Object.entries(PLAN_LABELS).find(([, label]) => label === planName)
    if (byName) return byName[0]
  }

  // 3) Last resort: the recurring price PayPal reports for this plan.
  const price = ppSub?.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price
  if (price?.currency_code === 'PHP' && price?.value != null) {
    const match = Object.entries(PLAN_PRICES).find(([, v]) => Number(v) === Number(price.value))
    if (match) return match[0]
  }

  return null
}

async function rememberPayPalPlan(sb, planId, plan) {
  if (!sb || !planId || !plan) return
  try {
    await sb.from('paypal_plans').upsert(
      { plan_id: planId, plan, created_at: new Date().toISOString() },
      { onConflict: 'plan_id' }
    )
  } catch (e) {
    console.warn('[Payment] Could not record PayPal plan mapping:', e?.message || e)
  }
}

// One PayPal subscription may only ever be bound to a single account.
async function subscriptionBoundToOtherUser(sb, subscriptionId, userId) {
  if (!sb || !subscriptionId) return false
  const { data, error } = await sb.from('profiles')
    .select('id')
    .eq('paypal_subscription_id', subscriptionId)
    .limit(1)
  if (error) {
    console.warn('[Payment] Subscription binding lookup failed:', error.message)
    return false
  }
  const row = (data || [])[0]
  return Boolean(row && row.id !== userId)
}

// ── Webhook signature verification ─────────────────────────────────────────────
// PayPal signs every webhook. Set PAYPAL_WEBHOOK_ID (from the PayPal dashboard) to
// enforce it. Even without it we re-verify each subscription with PayPal's API.
async function verifyWebhookSignature(c, rawBody) {
  const webhookId = c.env.PAYPAL_WEBHOOK_ID
  if (!webhookId) {
    console.warn('[Webhook] PAYPAL_WEBHOOK_ID not configured — signature check skipped (subscription is still re-verified with PayPal)')
    return true
  }
  try {
    const result = await ppFetch(c.env, '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        auth_algo:         c.req.header('paypal-auth-algo') || '',
        cert_url:          c.req.header('paypal-cert-url') || '',
        transmission_id:   c.req.header('paypal-transmission-id') || '',
        transmission_sig:  c.req.header('paypal-transmission-sig') || '',
        transmission_time: c.req.header('paypal-transmission-time') || '',
        webhook_id:        webhookId,
        webhook_event:     rawBody,
      }),
    })
    return result?.verification_status === 'SUCCESS'
  } catch (e) {
    console.error('[Webhook] Signature verification error:', e.message)
    return false
  }
}

// ── Apply PayPal's own view of a subscription to a profile ────────────────────
// Single place that writes billing state. Rules:
//   * active + plan resolved  → grant that plan
//   * inactive                → back to free
//   * active but plan unresolvable → keep the current plan (never punish a payer),
//     log loudly, and leave the subscription bound so support can reconcile
//   * profile already bound to a DIFFERENT subscription → ignore (stale webhook)
async function applySubscriptionState(sb, env, userId, subscriptionId, ppSub) {
  const now = new Date().toISOString()
  const status = (ppSub?.status || '').toLowerCase()
  const active = ['active', 'activated'].includes(status)
  const periodEnd = ppSub?.billing_info?.next_billing_time || null

  const { data: profile, error: readErr } = await sb.from('profiles')
    .select('plan, paypal_subscription_id')
    .eq('id', userId)
    .maybeSingle()
  if (readErr) console.error('[Payment] Profile read error:', readErr.message)

  const boundId = profile?.paypal_subscription_id || null
  if (boundId && boundId !== subscriptionId) {
    console.warn(`[Payment] Ignoring subscription ${subscriptionId} — user ${userId} is bound to ${boundId}`)
    return { skipped: true, plan: profile?.plan || 'free', active, status, periodEnd }
  }

  const plan = await resolvePlanFromPayPal(sb, env, ppSub)

  const patch = {
    paypal_subscription_id:  subscriptionId,
    subscription_status:     status,
    subscription_checked_at: now,
    current_period_end:      periodEnd,
  }

  if (active && plan) {
    patch.plan                    = plan
    patch.subscription_plan       = plan
    patch.subscription_started_at = ppSub?.start_time || now
  } else if (!active) {
    patch.plan = 'free'
  } else {
    console.error(`[Payment] ⚠️ Subscription ${subscriptionId} is active but its plan could not be resolved (plan_id: ${ppSub?.plan_id}). Keeping current plan; set PAYPAL_*_PLAN_ID secrets.`)
  }

  const { error: updateErr } = await sb.from('profiles').update(patch).eq('id', userId)
  if (updateErr) console.error('[Payment] Profile update error:', updateErr.message)

  return {
    skipped: false,
    plan: active ? (plan || profile?.plan || 'free') : 'free',
    resolvedPlan: plan,
    active,
    status,
    periodEnd,
  }
}

// ── POST /payment ──────────────────────────────────────────────────────────────
app.post('/', async (c) => {
  const { user, sb, error, status } = await getAuthUser(c)
  if (error) return c.json({ error }, status)

  const reqBody = await c.req.json()
  const { action, payload } = reqBody || {}
  if (!action) return c.json({ error: 'Missing action' }, 400)

  if (!c.env.PAYPAL_CLIENT_ID || !c.env.PAYPAL_CLIENT_SECRET)
    return c.json({ error: 'PayPal credentials not configured' }, 500)

  const userId = user.id

  try {

    // ════════════════════════════════════════════════════════════════════════
    // CREATE SUBSCRIPTION
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'create-subscription') {
      const { plan } = payload || {}
      if (!PLAN_PRICES[plan]) return c.json({ error: 'Invalid plan: ' + plan }, 400)

      // Use pre-created plan IDs if available (more reliable for production)
      const planId = c.env[`PAYPAL_${plan.toUpperCase()}_PLAN_ID`]
      
      if (planId) {
        // Use pre-created PayPal plan
        const sub = await ppFetch(c.env, '/v1/billing/subscriptions', {
          method: 'POST',
          body: JSON.stringify({
            plan_id: planId,
            start_time: new Date(Date.now() + 60000).toISOString(),
            subscriber: { email_address: user.email },
            custom_id: userId,
          }),
        })
        console.log(`[Payment] Subscription created: ${sub.id} for ${plan} user ${userId}`)
        return c.json({ subscriptionId: sub.id })
      } else {
        // Fallback: create a PayPal product + billing plan on-demand.
        // PayPal subscriptions require a product_id and pricing_scheme.fixed_price.
        const product = await ppFetch(c.env, '/v1/catalogs/products', {
          method: 'POST',
          body: JSON.stringify({
            name: PLAN_LABELS[plan],
            description: PLAN_LABELS[plan],
            type: 'DIGITAL',
            category: 'SOFTWARE',
          }),
        })

        const bp = await ppFetch(c.env, '/v1/billing/plans', {
          method: 'POST',
          body: JSON.stringify({
            product_id: product.id,
            name: PLAN_LABELS[plan],
            description: PLAN_LABELS[plan],
            status: 'ACTIVE',
            billing_cycles: [{
              frequency: { interval_unit: 'MONTH', interval_count: 1 },
              tenure_type: 'REGULAR',
              sequence: 1,
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: { currency_code: 'PHP', value: PLAN_PRICES[plan] },
              },
            }],
            payment_preferences: {
              auto_bill_outstanding: true,
              setup_fee: { currency_code: 'PHP', value: '0' },
              setup_fee_failure_action: 'CONTINUE',
              payment_failure_threshold: 3,
            },
          }),
        })

        // Record the mapping so activation can always resolve this plan server-side.
        await rememberPayPalPlan(sb, bp.id, plan)

        const sub = await ppFetch(c.env, '/v1/billing/subscriptions', {
          method: 'POST',
          body: JSON.stringify({
            plan_id: bp.id,
            start_time: new Date(Date.now() + 60000).toISOString(),
            subscriber: { email_address: user.email },
            custom_id: userId,
            application_context: {
              brand_name: 'Thyroxeia AI',
              locale: 'en-US',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'SUBSCRIBE_NOW',
            },
          }),
        })

        console.log(`[Payment] Subscription created: ${sub.id} for ${plan} user ${userId}`)
        return c.json({ subscriptionId: sub.id })
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTIVATE SUBSCRIPTION (verify with PayPal then update Supabase)
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'activate-subscription') {
      // NOTE: `plan` is intentionally read but IGNORED. The plan is resolved from
      // PayPal's response below, never from the browser.
      const { subscriptionId } = payload || {}
      if (!subscriptionId) return c.json({ error: 'Missing subscriptionId' }, 400)

      // Verify subscription directly with PayPal (never trust webhook body alone)
      let ppSub
      try {
        ppSub = await ppFetch(c.env, `/v1/billing/subscriptions/${subscriptionId}`)
      } catch (e) {
        console.error('[Payment] PayPal fetch error:', e.message)
        return c.json({ error: 'Could not verify subscription with PayPal' }, 500)
      }

      const subStatus = ppSub.status
      console.log(`[Payment] Verified subscription ${subscriptionId} — status: ${subStatus}`)

      // Only activate if subscription is ACTIVE
      if (!['ACTIVE', 'ACTIVATED'].includes(subStatus)) {
        return c.json({
          success: false,
          error:   `Subscription not active (status: ${subStatus}). No charges applied.`,
          status:  subStatus,
        })
      }

      // ── Authorization: the subscription must belong to the caller ──────────
      // custom_id is written server-side at creation time and comes back from PayPal.
      const ownerId = ppSub.custom_id || ''
      if (!ownerId) {
        console.warn(`[Payment] Subscription ${subscriptionId} has no custom_id — refusing activation`)
        return c.json({ error: 'This subscription is not linked to an account. Contact support.' }, 400)
      }
      if (ownerId !== userId) {
        console.warn(`[Payment] User ${userId} tried to activate subscription owned by ${ownerId}`)
        return c.json({ error: 'This subscription belongs to a different account.' }, 403)
      }
      if (await subscriptionBoundToOtherUser(sb, subscriptionId, userId)) {
        return c.json({ error: 'This subscription is already linked to another account.' }, 409)
      }

      // ── Plan: derived from PayPal, not from the request body ──────────────
      const applied = await applySubscriptionState(sb, c.env, userId, subscriptionId, ppSub)

      if (applied.skipped) {
        return c.json({ error: 'This account is already linked to a different subscription.' }, 409)
      }

      if (!applied.resolvedPlan) {
        // The binding IS stored, so a later reconcile can finish the job once the
        // plan mapping is configured — the customer is never silently downgraded.
        console.error(`[Payment] Could not resolve plan for subscription ${subscriptionId} (plan_id: ${ppSub.plan_id})`)
        return c.json({
          error: 'Your payment went through, but we could not confirm the plan yet. It will be applied automatically — contact support if it does not appear within a few minutes.',
          subscriptionId,
        }, 422)
      }

      console.log(`[Payment] ✅ ${applied.plan} activated for user ${userId}, subscription ${subscriptionId}`)

      return c.json({
        success: true,
        plan: applied.plan,
        subscriptionId,
        status: applied.status,
        current_period_end: applied.periodEnd,
      })
    }

    // ════════════════════════════════════════════════════════════════════════
    // RECONCILE SUBSCRIPTION (self-heal on login)
    // Uses the subscription id stored on the profile — the client cannot choose it.
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'reconcile-subscription') {
      const { data: profile, error: profileErr } = await sb.from('profiles')
        .select('plan, paypal_subscription_id')
        .eq('id', userId)
        .maybeSingle()
      if (profileErr) return c.json({ error: 'Could not read your profile.' }, 500)

      const subscriptionId = profile?.paypal_subscription_id
      if (!subscriptionId) {
        return c.json({ success: true, active: false, plan: profile?.plan || 'free', reason: 'no-subscription' })
      }

      let ppSub
      try {
        ppSub = await ppFetch(c.env, `/v1/billing/subscriptions/${subscriptionId}`)
      } catch (e) {
        console.warn('[Payment] Reconcile: PayPal lookup failed:', e.message)
        return c.json({ success: true, active: false, plan: profile?.plan || 'free', reason: 'paypal-unavailable' })
      }

      if ((ppSub.custom_id || '') !== userId) {
        console.warn(`[Payment] Reconcile: subscription ${subscriptionId} is not owned by ${userId}`)
        return c.json({ error: 'This subscription belongs to a different account.' }, 403)
      }

      const applied = await applySubscriptionState(sb, c.env, userId, subscriptionId, ppSub)
      return c.json({
        success: true,
        active: applied.active,
        plan: applied.plan,
        status: applied.status,
        current_period_end: applied.periodEnd,
      })
    }

    // ════════════════════════════════════════════════════════════════════════
    // CHECK SUBSCRIPTION
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'check-subscription') {
      const { subscriptionId } = payload || {}
      if (!subscriptionId) return c.json({ error: 'Missing subscriptionId' }, 400)

      try {
        const ppSub = await ppFetch(c.env, `/v1/billing/subscriptions/${subscriptionId}`)

        // Only the owner of the subscription may query it.
        if ((ppSub.custom_id || '') !== userId) {
          return c.json({ error: 'This subscription belongs to a different account.' }, 403)
        }

        const applied = await applySubscriptionState(sb, c.env, userId, subscriptionId, ppSub)

        if (!applied.active) {
          return c.json({
            active:     false,
            status:     ppSub.status,
            plan:       applied.plan,
            downgraded: true,
          })
        }

        return c.json({
          active:             true,
          status:             applied.status,
          plan:               applied.plan,
          current_period_end: applied.periodEnd,
        })
      } catch (e) {
        return c.json({ active: false, error: e.message })
      }
    }

    return c.json({ error: 'Unknown action: ' + action }, 400)

  } catch (err) {
    console.error('[Payment route error]', err.message)
    return c.json({ error: 'Payment processing failed. Please try again.' }, 500)
  }
})

// ── POST /payment/webhook ──────────────────────────────────────────────────────
// PayPal sends webhook events here. We verify each subscription by calling
// PayPal directly — we NEVER trust the webhook body alone.
app.post('/webhook', async (c) => {
  const rawText = await c.req.text()
  let body
  try { body = JSON.parse(rawText) } catch { return c.json({ received: true, ignored: true, reason: 'Invalid JSON' }) }

  if (!(await verifyWebhookSignature(c, body))) {
    console.warn('[Webhook] Rejected: signature verification failed')
    return c.json({ error: 'Invalid signature' }, 401)
  }

  const eventType = body.event_type || ''
  const resource  = body.resource   || {}
  const subscriptionId = resource.id || null

  console.log(`[Webhook] Received: ${eventType} — ${subscriptionId}`)

  if (!subscriptionId) {
    return c.json({ received: true, ignored: true, reason: 'No subscription ID' })
  }

  // Always verify with PayPal first
  try {
    const ppSub = await ppFetch(c.env, `/v1/billing/subscriptions/${subscriptionId}`)
    const status = ppSub.status
    const customId = ppSub.custom_id || ''

    console.log(`[Webhook] Verified ${subscriptionId} — status: ${status}, user: ${customId}`)

    if (!customId) {
      return c.json({ received: true, ignored: true, reason: 'No user ID in subscription' })
    }

    const sb = (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY)
      ? createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
      : null

    if (!sb) {
      console.warn('[Webhook] Supabase not configured — cannot apply subscription state')
      return c.json({ received: true, processed: false })
    }

    const applied = await applySubscriptionState(sb, c.env, customId, subscriptionId, ppSub)
    if (applied.skipped) {
      return c.json({ received: true, ignored: true, reason: 'Profile is bound to another subscription' })
    }

    console.log(`[Webhook] ${subscriptionId} — ${applied.status}; plan: ${applied.plan}`)

    return c.json({ received: true, processed: true })

  } catch (e) {
    console.error('[Webhook] Error:', e.message)
    return c.json({ received: true, error: 'Webhook processing failed' }, 500)
  }
})

// ── Lazy expiry check ────────────────────────────────────────────────────────
// Called from the AI route. If the profile claims a paid plan but the paid period
// has already ended, re-ask PayPal (once) instead of trusting stale data:
//   * still ACTIVE  -> refresh the period end, keep the plan
//   * cancelled/expired -> downgrade to free
// Accounts with no period end (owner grants) and free accounts are left alone.
async function reconcileIfStale(sb, env, userId, profile) {
  const currentPlan = profile?.plan || 'free'
  const periodEnd = profile?.current_period_end
  if (currentPlan === 'free' || !periodEnd) return { plan: currentPlan, changed: false }

  const endMs = new Date(periodEnd).getTime()
  if (!Number.isFinite(endMs) || endMs > Date.now()) return { plan: currentPlan, changed: false }

  const subscriptionId = profile?.paypal_subscription_id
  if (!subscriptionId) return { plan: currentPlan, changed: false }

  try {
    const ppSub = await ppFetch(env, `/v1/billing/subscriptions/${subscriptionId}`)
    if ((ppSub.custom_id || '') !== userId) return { plan: currentPlan, changed: false }
    const applied = await applySubscriptionState(sb, env, userId, subscriptionId, ppSub)
    return { plan: applied.plan, changed: applied.plan !== currentPlan }
  } catch (e) {
    console.warn('[Payment] Lazy expiry check failed:', e?.message || e)
    return { plan: currentPlan, changed: false }
  }
}

export default app

// Exported for tests — pure-ish helpers that take an injected Supabase client.
export { resolvePlanFromPayPal, applySubscriptionState, subscriptionBoundToOtherUser, reconcileIfStale, PLAN_PRICES }
