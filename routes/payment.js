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

// ── Downgrade user to free ─────────────────────────────────────────────────────
async function downgradeToFree(sb, userId) {
  if (!sb || !userId) return
  const now = new Date().toISOString()
  await sb.from('profiles').update({
    plan:                'free',
    subscription_status: 'cancelled',
    subscription_checked_at: now,
  }).eq('id', userId)
  console.log(`[Payment] ⬇️ User ${userId} downgraded to free (subscription ${now})`)
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
      const { subscriptionId, plan } = payload || {}
      if (!subscriptionId) return c.json({ error: 'Missing subscriptionId' }, 400)
      if (!PLAN_PRICES[plan]) return c.json({ error: 'Invalid plan: ' + plan }, 400)

      // Verify subscription directly with PayPal (never trust webhook body alone)
      let ppSub
      try {
        ppSub = await ppFetch(c.env, `/v1/billing/subscriptions/${subscriptionId}`)
      } catch (e) {
        console.error('[Payment] PayPal fetch error:', e.message)
        return c.json({ error: 'Could not verify subscription with PayPal' }, 500)
      }

      const status = ppSub.status
      console.log(`[Payment] Verified subscription ${subscriptionId} — status: ${status}`)

      // Only activate if subscription is ACTIVE
      if (!['ACTIVE', 'ACTIVATED'].includes(status)) {
        return c.json({
          success: false,
          error:   `Subscription not active (status: ${status}). No charges applied.`,
          status,
        })
      }

      // Get billing info for period end
      const billingInfo = ppSub.billing_info || {}
      const periodEnd = billingInfo.next_billing_time || null

      // Update Supabase profile
      const now = new Date().toISOString()
      const { error: updateErr } = await sb.from('profiles').update({
        plan:                   plan,
        paypal_subscription_id: subscriptionId,
        subscription_status:    status.toLowerCase(),
        subscription_plan:      plan,
        subscription_started_at: now,
        subscription_checked_at: now,
        current_period_end:     periodEnd,
      }).eq('id', userId)

      if (updateErr) console.error('[Payment] Profile update error:', updateErr.message)

      console.log(`[Payment] ✅ ${plan} activated for user ${userId}, subscription ${subscriptionId}`)

      return c.json({
        success: true,
        plan,
        subscriptionId,
        status: status.toLowerCase(),
        current_period_end: periodEnd,
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
        const status = ppSub.status
        const billingInfo = ppSub.billing_info || {}

        // If subscription is no longer active, downgrade
        if (!['ACTIVE', 'ACTIVATED'].includes(status)) {
          await downgradeToFree(sb, userId)
          return c.json({
            active:    false,
            status,
            downgraded: true,
          })
        }

        return c.json({
          active:           true,
          status:           status.toLowerCase(),
          current_period_end: billingInfo.next_billing_time || null,
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
  const body = await c.req.json()
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
    const billingInfo = ppSub.billing_info || {}
    const customId = ppSub.custom_id || ''

    console.log(`[Webhook] Verified ${subscriptionId} — status: ${status}, user: ${customId}`)

    if (!customId) {
      return c.json({ received: true, ignored: true, reason: 'No user ID in subscription' })
    }

    const sb = (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY)
      ? createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
      : null

    const now = new Date().toISOString()
    const inactiveStatuses = ['CANCELLED', 'SUSPENDED', 'EXPIRED', 'PAUSED']

    if (inactiveStatuses.includes(status)) {
      // Downgrade inactive/cancelled/suspended/expired subscriptions to free
      if (sb) {
        await sb.from('profiles').update({
          plan:                   'free',
          subscription_status:    status.toLowerCase(),
          subscription_checked_at: now,
          current_period_end:     billingInfo.next_billing_time || null,
        }).eq('paypal_subscription_id', subscriptionId)
        console.log(`[Webhook] ⬇️ Subscription ${subscriptionId} — downgraded user to free`)
      }
    } else if (status === 'ACTIVE') {
      // Subscription still active — update check timestamp
      if (sb) {
        await sb.from('profiles').update({
          subscription_status:    'active',
          subscription_checked_at: now,
          current_period_end:     billingInfo.next_billing_time || null,
        }).eq('paypal_subscription_id', subscriptionId)
        console.log(`[Webhook] ✅ Subscription ${subscriptionId} — verified active`)
      }
    }

    return c.json({ received: true, processed: true })

  } catch (e) {
    console.error('[Webhook] Error:', e.message)
    return c.json({ received: true, error: 'Webhook processing failed' }, 500)
  }
})

export default app
