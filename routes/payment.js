/**
 * /payment  — PayPal order creation & server-side capture verification
 *
 * POST /payment
 * Requires: Authorization: Bearer <supabase_jwt>
 * Body: { action: 'create-order' | 'capture-order', payload: { plan, orderId? } }
 * NOTE: userId is always taken from the verified JWT — never from request body
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

// Prices in PHP — converted from USD at ~₱57/USD (BSP April 2026)
// Free: $25 | Student: $60 | Pro: $150 | Elite: $300
const PLAN_PRICES = {
  free:    { amount: '1425.00', currency: 'PHP', label: 'Thyroxeia AI — Free Plan (Monthly)'    },
  student: { amount: '3420.00', currency: 'PHP', label: 'Thyroxeia AI — Student Plan (Monthly)' },
  pro:     { amount: '8550.00', currency: 'PHP', label: 'Thyroxeia AI — Pro Plan (Monthly)'     },
  elite:   { amount: '17100.00', currency: 'PHP', label: 'Thyroxeia AI — Elite Plan (Monthly)'  },
}

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── JWT Auth Middleware ───────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required.' })
  if (!sb) return res.status(500).json({ error: 'Auth service not configured.' })

  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })

  req.user = user
  next()
}

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

// ── POST /payment — requires valid JWT ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { action, payload } = req.body || {}
  if (!action || !payload) return res.status(400).json({ error: 'Missing action or payload' })
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'PayPal credentials not configured on server' })
  }

  // userId always comes from the verified JWT — never from the request body
  const userId = req.user.id

  try {
    // ── CREATE ORDER ─────────────────────────────────────────────────────────
    if (action === 'create-order') {
      const { plan } = payload
      if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan: ' + plan })

      const price = PLAN_PRICES[plan]
      const order = await ppFetch('/v2/checkout/orders', {
        method: 'POST',
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: price.currency, value: price.amount },
            description: price.label,
            custom_id: `${userId}::${plan}`,  // ties order to verified user+plan
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

    // ── CAPTURE ORDER ─────────────────────────────────────────────────────────
    if (action === 'capture-order') {
      const { orderId, plan } = payload
      if (!orderId || !plan) return res.status(400).json({ error: 'Missing orderId or plan' })
      if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan: ' + plan })

      const capture = await ppFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' })

      // ── Server-side verification ──────────────────────────────────────────
      const unit          = capture.purchase_units?.[0]
      const captureDetail = unit?.payments?.captures?.[0]
      const status        = captureDetail?.status
      const amtValue      = captureDetail?.amount?.value
      const customId      = unit?.custom_id || ''
      const expected      = PLAN_PRICES[plan].amount

      if (status !== 'COMPLETED') {
        console.warn('[Payment] Capture not COMPLETED:', status, orderId)
        return res.json({ success: false, reason: 'Payment not completed' })
      }
      if (parseFloat(amtValue) < parseFloat(expected)) {
        console.warn('[Payment] Amount mismatch:', amtValue, 'expected', expected)
        return res.json({ success: false, reason: 'Amount mismatch — possible manipulation' })
      }
      // Verify the order was created for THIS authenticated user
      if (!customId.startsWith(userId) || !customId.includes(plan)) {
        console.warn('[Payment] custom_id mismatch:', customId, 'for user', userId)
        return res.json({ success: false, reason: 'Order metadata mismatch' })
      }

      // ── Persist to Supabase ───────────────────────────────────────────────
      if (sb) {
        const { error: upsertErr } = await sb.from('profiles').upsert({
          id: userId,
          plan,
          paypal_order_id: orderId,
          plan_activated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        if (upsertErr) console.error('[Supabase profiles upsert]', upsertErr.message)
      }

      console.log(`[Payment] ✅ ${plan} activated for user ${userId}, order ${orderId}`)
      return res.json({ success: true, orderId, plan })
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    console.error('[Payment route error]', err.message)
    res.status(500).json({ error: 'Payment processing failed. Please try again.' })
  }
})

export default router
