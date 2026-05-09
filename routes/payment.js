
/**
 * /payment  — PayPal order creation & server-side capture verification
 *
 * POST /payment
 * Requires: Authorization: Bearer <supabase_jwt>
 * Body: { action: 'create-order' | 'capture-order', payload: { plan, orderId? } }
 *
 * Anti-double-charge: capture is fully idempotent — if the same orderId was
 * already processed, we return success immediately without hitting PayPal again.
 *
 * Elite auto-triggers: shoutout insert + welcome email happen server-side so
 * a dropped network connection after capture never leaves elite benefits unset.
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

const PLAN_PRICES = {
  student: { amount: '110.00', currency: 'PHP', label: 'Thyroxeia AI — Student Plan (Monthly)' },
  pro:     { amount: '220.00', currency: 'PHP', label: 'Thyroxeia AI — Pro Plan (Monthly)'     },
  elite:   { amount: '280.00', currency: 'PHP', label: 'Thyroxeia AI — Elite Plan (Monthly)'   },
}

// ── HTML escape (used for shoutout displayName) ───────────────────────────────
function escapeHtml(str) {
  if (typeof str !== 'string') return ''
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;')
}

// ── Resend email (same helper as auth-email.js) ────────────────────────────────
async function sendEmail(env, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html })
  })
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Elite welcome email template (copied from auth-email.js) ──────────────────
function eliteWelcomeTemplate(firstName) {
  const safeName = escapeHtml(firstName)
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif;color:#f1f5f9}
  .wrap{max-width:520px;margin:40px auto;background:#12121a;border:2px solid rgba(245,158,11,.4);border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#b45309,#f59e0b,#fcd34d);padding:36px 40px;text-align:center}
  .header h1{margin:0;font-size:1.6rem;font-weight:900;color:#1a1a00}
  .body{padding:36px 40px}
  .perk{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px 16px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px}
  .footer{padding:20px 40px;border-top:1px solid rgba(245,158,11,.2);font-size:.78rem;color:#92400e;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>👑 Welcome to Elite!</h1><p style="margin:6px 0 0;font-weight:600;color:#78350f">You're now part of the top tier.</p></div>
  <div class="body">
    <p style="font-size:1.05rem;font-weight:600">Congratulations, ${safeName || 'Champion'}! 🏆</p>
    <p style="color:#94a3b8;margin:8px 0 24px">Your Elite plan is now active. Here's what you unlocked:</p>
    <div class="perk"><span style="font-size:1.3rem">⚡</span><div><strong>Everything in Pro</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">300 AI calls/day, unlimited decks, all study modes.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">🌟</span><div><strong>Gold Username Badge</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Your name appears in gold across the platform.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">📢</span><div><strong>Server-Wide Shoutout</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Every user sees your welcome announcement when they log in.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">🎯</span><div><strong>Priority Support</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Your support tickets jump to the front of the queue.</p></div></div>
  </div>
  <div class="footer">© ${new Date().getFullYear()} Thyroxeia AI Elite · Thank you for your support 👑</div>
</div>
</body></html>`
}

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
  return env.PAYPAL_MODE === 'sandbox'
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
  const data = await resp.json()
  return data.access_token
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
  // 422 UNPROCESSABLE_ENTITY from PayPal often means ORDER_ALREADY_CAPTURED —
  // bubble the body up so the caller can handle it gracefully
  if (!resp.ok) {
    const err = new Error(`PayPal API error ${resp.status}: ${JSON.stringify(body).substring(0, 300)}`)
    err.status = resp.status
    err.body   = body
    throw err
  }
  return body
}

// ── POST /payment ──────────────────────────────────────────────────────────────
app.post('/', async (c) => {
  const { user, sb, error, status } = await getAuthUser(c)
  if (error) return c.json({ error }, status)

  const reqBody = await c.req.json()
  const { action, payload } = reqBody || {}
  if (!action || !payload) return c.json({ error: 'Missing action or payload' }, 400)

  if (!c.env.PAYPAL_CLIENT_ID || !c.env.PAYPAL_CLIENT_SECRET)
    return c.json({ error: 'PayPal credentials not configured on server' }, 500)

  const userId = user.id  // always from JWT — never from request body

  try {

    // ════════════════════════════════════════════════════════════════════════
    // CREATE ORDER
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'create-order') {
      const { plan } = payload
      if (!PLAN_PRICES[plan]) return c.json({ error: 'Invalid plan: ' + plan }, 400)

      // ── Guard: user already on this plan? ──────────────────────────────────
      // Prevents accidental double-upgrades but still allows downgrades/changes
      if (sb) {
        const { data: profile } = await sb
          .from('profiles').select('plan').eq('id', userId).single()
        if (profile?.plan === plan) {
          return c.json({
            error: `You already have the ${plan} plan active. Contact support if you need to renew.`
          }, 409)
        }
      }

      const price = PLAN_PRICES[plan]
      const order = await ppFetch(c.env, '/v2/checkout/orders', {
        method: 'POST',
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount:      { currency_code: price.currency, value: price.amount },
            description: price.label,
            custom_id:   `${userId}::${plan}`,  // ties order to this verified user+plan
          }],
          application_context: { brand_name: 'Thyroxeia AI', user_action: 'PAY_NOW' },
        }),
      })

      console.log(`[Payment] Order created: ${order.id} for ${plan} plan, user ${userId}`)
      return c.json({ orderId: order.id })
    }

    // ════════════════════════════════════════════════════════════════════════
    // CAPTURE ORDER  (fully idempotent — safe to retry)
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'capture-order') {
      const { orderId, plan } = payload
      if (!orderId || !plan) return c.json({ error: 'Missing orderId or plan' }, 400)
      if (!PLAN_PRICES[plan]) return c.json({ error: 'Invalid plan: ' + plan }, 400)

      // ── Idempotency check: was this exact order already processed? ─────────
      // If yes, skip PayPal and return success — prevents any double-charge risk
      if (sb) {
        const { data: existing } = await sb
          .from('profiles')
          .select('plan, paypal_order_id')
          .eq('id', userId)
          .single()

        if (existing?.paypal_order_id === orderId) {
          console.log(`[Payment] ✅ Idempotent: order ${orderId} already processed for user ${userId}`)
          return c.json({ success: true, orderId, plan: existing.plan, alreadyProcessed: true })
        }
      }

      // ── Capture with PayPal ────────────────────────────────────────────────
      let capture
      try {
        capture = await ppFetch(c.env, `/v2/checkout/orders/${orderId}/capture`, { method: 'POST' })
      } catch (ppErr) {
        // PayPal returns 422 with ORDER_ALREADY_CAPTURED if we somehow hit it twice
        // Treat it as success since money was already collected
        if (
          ppErr.status === 422 &&
          JSON.stringify(ppErr.body || '').includes('ORDER_ALREADY_CAPTURED')
        ) {
          console.warn(`[Payment] ORDER_ALREADY_CAPTURED from PayPal for ${orderId} — treating as success`)
          // Fall through with a synthetic capture result pulled from Supabase
          if (sb) {
            const { data: alreadyDone } = await sb
              .from('profiles').select('plan').eq('id', userId).single()
            return c.json({ success: true, orderId, plan: alreadyDone?.plan || plan, alreadyProcessed: true })
          }
          return c.json({ success: true, orderId, plan, alreadyProcessed: true })
        }
        throw ppErr  // rethrow anything else
      }

      // ── Server-side verification ───────────────────────────────────────────
      const unit          = capture.purchase_units?.[0]
      const captureDetail = unit?.payments?.captures?.[0]
      const captureStatus = captureDetail?.status
      const amtValue      = captureDetail?.amount?.value
      const customId      = unit?.custom_id || ''
      const expected      = PLAN_PRICES[plan].amount

      if (captureStatus !== 'COMPLETED') {
        console.warn('[Payment] Capture not COMPLETED:', captureStatus, orderId)
        return c.json({ success: false, reason: 'Payment not completed' })
      }
      if (parseFloat(amtValue) < parseFloat(expected)) {
        console.warn('[Payment] Amount mismatch:', amtValue, 'expected', expected)
        return c.json({ success: false, reason: 'Amount mismatch — possible manipulation' })
      }
      // Verify the order was created for THIS authenticated user + plan
      if (!customId.startsWith(userId) || !customId.includes(plan)) {
        console.warn('[Payment] custom_id mismatch:', customId, 'for user', userId)
        return c.json({ success: false, reason: 'Order metadata mismatch' })
      }

      // ── Persist plan to Supabase ───────────────────────────────────────────
      if (sb) {
        const { error: upsertErr } = await sb.from('profiles').upsert({
          id:                userId,
          plan,
          paypal_order_id:   orderId,
          plan_activated_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        if (upsertErr) console.error('[Supabase profiles upsert]', upsertErr.message)
      }

      console.log(`[Payment] ✅ ${plan} activated for user ${userId}, order ${orderId}`)

      // ── Elite-only server-side triggers ───────────────────────────────────
      // Done here (not client-side) so they can NEVER be silently skipped due
      // to a dropped network connection after payment.
      if (plan === 'elite' && sb) {
        // 1. Insert shoutout (ignore if already exists — user paid once)
        const displayName = user.email?.split('@')[0] || 'Elite Member'
        const safeDisplayName = escapeHtml(String(displayName).slice(0, 100))
        const { data: existingShoutout } = await sb
          .from('shoutouts').select('id').eq('user_id', userId).single()

        if (!existingShoutout) {
          const { error: shoutErr } = await sb.from('shoutouts').insert({
            user_id:      userId,
            display_name: safeDisplayName,
            created_at:   new Date().toISOString(),
          })
          if (shoutErr) console.error('[Elite shoutout error]', shoutErr.message)
          else console.log(`[Elite] 📢 Shoutout created for ${userId}`)
        }

        // 2. Send elite welcome email (fire-and-forget — don't fail the response)
        if (c.env.RESEND_API_KEY && c.env.EMAIL_FROM) {
          const firstName = user.email?.split('@')[0] || ''
          sendEmail(
            c.env,
            user.email,
            '👑 You are now Elite — welcome to the top!',
            eliteWelcomeTemplate(firstName)
          ).catch(e => console.error('[Elite email error]', e.message))
        }
      }

      return c.json({ success: true, orderId, plan })
    }

    return c.json({ error: 'Unknown action: ' + action }, 400)

  } catch (err) {
    console.error('[Payment route error]', err.message)
    return c.json({ error: 'Payment processing failed. Please try again.' }, 500)
  }
})

export default app
