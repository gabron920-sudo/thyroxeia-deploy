/**
 * /payment  — PayPal order creation & server-side capture verification
 *
 * POST /payment
 * Body: { action: 'create-order' | 'capture-order', payload: { plan, userId, orderId? } }
 */

import { Router }     from 'express'
import { createClient } from '@supabase/supabase-js'

const router = Router()

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET
const PAYPAL_MODE          = process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox' : 'live'
const PAYPAL_API           = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

// ── Updated plan prices (monthly) ────────────────────────────────────────────
const PLAN_PRICES = {
  student: { amount: '110.00', currency: 'PHP', label: 'Thyroxeia AI — Student Plan (Monthly)' },
  pro:     { amount: '220.00', currency: 'PHP', label: 'Thyroxeia AI — Pro Plan (Monthly)'     },
  elite:   { amount: '280.00', currency: 'PHP', label: 'Thyroxeia AI — Elite Plan (Monthly)'   },
}

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── PayPal token cache ────────────────────────────────────────────────────────
let _ppToken = null, _ppTokenExpires = 0
async function getPayPalToken() {
  const { default: fetch } = await import('node-fetch')
  if (_ppToken && Date.now() < _ppTokenExpires) return _ppToken
  const resp = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  })
  if (!resp.ok) throw new Error(`PayPal auth failed: ${resp.status}`)
  const data = await resp.json()
  _ppToken        = data.access_token
  _ppTokenExpires = Date.now() + (data.expires_in - 60) * 1000
  return _ppToken
}

async function ppFetch(path, options = {}) {
  const { default: fetch } = await import('node-fetch')
  const token = await getPayPalToken()
  const resp = await fetch(`${PAYPAL_API}${path}`, {
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
  if (!resp.ok) throw new Error(`PayPal API error ${resp.status}: ${JSON.stringify(body).substring(0, 300)}`)
  return body
}

// ── POST /payment ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { action, payload } = req.body || {}
  if (!action || !payload) return res.status(400).json({ error: 'Missing action or payload' })
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'PayPal credentials not configured on server' })
  }

  try {
    // ── CREATE ORDER ──────────────────────────────────────────────────────
    if (action === 'create-order') {
      const { plan, userId } = payload
      if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan: ' + plan })
      if (!userId) return res.status(400).json({ error: 'Missing userId' })

      const price = PLAN_PRICES[plan]
      const order = await ppFetch('/v2/checkout/orders', {
        method: 'POST',
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: price.currency, value: price.amount },
            description: price.label,
            custom_id: `${userId}::${plan}`,  // security: ties order to specific user+plan
          }],
          application_context: {
            brand_name: 'Thyroxeia AI',
            user_action: 'PAY_NOW',
          },
        }),
      })
      console.log(`[Payment] Order created: ${order.id} for ${plan} plan, user ${userId}`)
      return res.json({ orderId: order.id })
    }

    // ── CAPTURE ORDER ──────────────────────────────────────────────────────
    if (action === 'capture-order') {
      const { orderId, plan, userId } = payload
      if (!orderId || !plan || !userId) return res.status(400).json({ error: 'Missing orderId/plan/userId' })
      if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan: ' + plan })

      const capture = await ppFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' })

      // ── Server-side verification (critical security checks) ───────────
      const unit          = capture.purchase_units?.[0]
      const captureDetail = unit?.payments?.captures?.[0]
      const status        = captureDetail?.status        // must be 'COMPLETED'
      const amtValue      = captureDetail?.amount?.value // must match plan price
      const customId      = unit?.custom_id || ''        // must match userId::plan
      const expected      = PLAN_PRICES[plan].amount

      if (status !== 'COMPLETED') {
        console.warn('[Payment] Capture not COMPLETED:', status, orderId)
        return res.json({ success: false, reason: 'Payment not completed' })
      }
      if (parseFloat(amtValue) < parseFloat(expected)) {
        console.warn('[Payment] Amount mismatch:', amtValue, 'expected', expected)
        return res.json({ success: false, reason: 'Amount mismatch — possible manipulation' })
      }
      if (!customId.startsWith(userId) || !customId.includes(plan)) {
        console.warn('[Payment] custom_id mismatch:', customId)
        return res.json({ success: false, reason: 'Order metadata mismatch' })
      }

      // ── Persist to Supabase ────────────────────────────────────────────
      if (sb) {
        const { error: upsertErr } = await sb.from('profiles').upsert({
          id: userId,
          plan,
          paypal_order_id: orderId,
          plan_activated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        if (upsertErr) console.error('[Supabase profiles upsert]', upsertErr.message)
      } else {
        console.warn('[Payment] Supabase not configured — plan not saved to DB')
      }

      console.log(`[Payment] ✅ ${plan} activated for user ${userId}, order ${orderId}`)
      return res.json({ success: true, orderId, plan, userId })
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    console.error('[Payment route error]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
