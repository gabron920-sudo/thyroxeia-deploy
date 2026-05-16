import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin.js'

const app = new Hono()

function patchHtml(html) {
  const oldPayPalContainer = String.raw`<div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime.</p>`

  const newPayPalContainer = String.raw`<label style="display:flex;gap:10px;align-items:flex-start;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:12px;margin-bottom:16px;cursor:pointer">
      <input type="checkbox" id="no-refunds-ack" onchange="handleNoRefundsAck()" style="margin-top:2px;accent-color:#ef4444" />
      <span class="text-xs" style="color:var(--text2);line-height:1.5"><strong style="color:#ef4444">No refunds:</strong> I understand purchases are non-refundable for the current billing period. I can cancel anytime to stop future renewals.</span>
    </label>
    <div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime to stop future renewals. No refunds for the current billing period.</p>`

  const oldRenderStart = String.raw`function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')`

  const newRenderStart = String.raw`function handleNoRefundsAck() { if (pendingPlan) renderPayPal(pendingPlan) }
function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')
  const noRefundsAck = document.getElementById('no-refunds-ack')
  if (!noRefundsAck || !noRefundsAck.checked) {
    container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text3);border:1px dashed var(--border);border-radius:12px">Check the no-refunds acknowledgement above to continue to PayPal.</div>'
    return 
  }`

  return html
    .replace(/
\s*timed:\s*\['student','pro','elite'\],/g, '')
    .replace(/
\s*type:\s*\['student','pro','elite'\],/g, '')
    .replace(/\s*timed:\s*\['student','pro','elite'\],/g, '')
    .replace(/\s*type:\s*\['student','pro','elite'\],/g, '')
    .replace('const PLAN_LIMITS = { free: 25, student: 60, pro: 150, elite: 300 }', 'const PLAN_LIMITS = { free: 15, student: 40, pro: 80, elite: 120 }')
    .replace(/25 AI calls\/day/g, '15 AI calls/day')
    .replace(/60 AI calls\/day/g, '40 AI calls/day')
    .replace(/150 AI calls\/day/g, '80 AI calls/day')
    .replace(/300 AI calls\/day/g, '120 AI calls/day')    .replace(/\n\s*timed:\s*\['student','pro','elite'\],/g, '')
    .replace(/\n\s*type:\s*\['student','pro','elite'\],/g, '')
    .replace('<li class="no"><span class="check-no">✗</span> Quiz & Timed modes</li>', '<li class="yes"><span class="check-yes">✓</span> Timed Test & Type Answer</li><li class="no"><span class="check-no">✗</span> Quiz Mode</li>')
    .replace('2 decks · 30 cards · 25 AI calls/day', '2 decks · 30 cards · Timed + Type Answer · 25 AI calls/day')
    .replace('&intent=${intent}&disable-funding=credit,card', '&intent=${intent}&vault=true&disable-funding=credit,card')
    .replace('redirectTo: window.location.origin + window.location.pathname', "redirectTo: window.location.origin + window.location.pathname + '?reset=1'")
    .replace(
      "if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {",
      "if (event === 'PASSWORD_RECOVERY' && session?.user) { currentUser = session.user; showPasswordReset(); return }\n  if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {"
    )
    .replace(
      'async function handleForgotPassword() {',
      String.raw`function showPasswordReset() {
  showPage('auth')
  const box = document.querySelector('#page-auth .auth-box') || document.querySelector('#page-auth .glass') || document.getElementById('page-auth')
  if (!box) return
  box.innerHTML = ` + "`" + `<h2 class="font-bold text-2xl mb-2">Reset Password</h2>
    <p class="text-sm mb-4" style="color:var(--text2)">Enter your new password below.</p>
    <div class="mb-4"><label class="label">New Password</label><input class="input" type="password" id="reset-new-password" placeholder="New password" minlength="8" /></div>
    <div class="mb-4"><label class="label">Confirm Password</label><input class="input" type="password" id="reset-confirm-password" placeholder="Confirm password" minlength="8" /></div>
    <button class="btn btn-primary w-full" onclick="handlePasswordUpdate()">Update Password</button>
    <button class="btn btn-ghost w-full mt-3" onclick="showAuth('login')">Back to login</button>` + "`" + `
}

async function handlePasswordUpdate() {
  const pass = document.getElementById('reset-new-password')?.value || ''
  const conf = document.getElementById('reset-confirm-password')?.value || ''
  if (pass.length < 8) { toast('Password must be at least 8 characters.', 'error'); return }
  if (pass !== conf) { toast('Passwords do not match.', 'error'); return }
  const { error } = await sb.auth.updateUser({ password: pass })
  if (error) { toast(error.message || 'Password update failed.', 'error'); return }
  toast('Password updated. Please log in again.', 'success')
  await sb.auth.signOut()
  showAuth('login')
}

async function handleForgotPassword() {`
    )
    .replace(oldPayPalContainer, newPayPalContainer)
    .replace('thinking.innerHTML = data.reply\n      .replace', 'thinking.innerHTML = (data.reply || data.text || data.message || 'No response from AI.')\n      .replace')
    .replace('content.innerHTML = data.guide\n      .replace', 'content.innerHTML = (data.guide || data.text || data.reply || 'No study guide returned.')\n      .replace')
    .replace(oldRenderStart, newRenderStart)
}

async function maybePatchHtmlResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/html')) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('cache-control', 'no-store')
  return new Response(patchHtml(await response.text()), { status: response.status, statusText: response.statusText, headers })
}

// CORS — locked to approved frontends in production.
// Set ALLOWED_ORIGINS as comma-separated origins if you add a custom domain.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://thyroxeia.fancy-sky-31cf.workers.dev',
]

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)

    // Allow same-origin/server-to-server requests with no Origin header.
    if (!origin) return origin
    return allowed.includes(origin) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// API routes
app.route('/ai',      aiRouter)
app.route('/auth',    authRouter)
app.route('/payment', paymentRouter)
app.route('/admin',   adminRouter)

app.get('/api/paypal-config', (c) =>
  c.json({
    clientId: c.env.PAYPAL_CLIENT_ID,
    mode: c.env.PAYPAL_MODE ?? 'live',
    currency: 'PHP',
    intent: 'subscription',
    vault: true,
  })
)

app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

// Serve static assets first, then fall back to /index.html for SPA routes.
// This fixes direct frontend routes like /login, /verify, /dashboard, /checkout.
app.get('*', async (c) => {
  try {
    const asset = await c.env.ASSETS.fetch(c.req.raw)

    if (asset.status >= 200 && asset.status < 300) {
      return maybePatchHtmlResponse(asset)
    }
  } catch (err) {
    console.warn('[Assets] direct asset fetch failed:', err?.message || err)
  }

  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  url.search = ''

  const indexRequest = new Request(url.toString(), c.req.raw)
  return maybePatchHtmlResponse(await c.env.ASSETS.fetch(indexRequest))
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
