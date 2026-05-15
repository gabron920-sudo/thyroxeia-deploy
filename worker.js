import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin.js'

const app = new Hono()

function patchHtml(html) {
  return html
    .replace('&intent=${intent}&disable-funding=credit,card', '&intent=${intent}&vault=true&disable-funding=credit,card')
    .replace(
      '<div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime.</p>',
      `<label style="display:flex;gap:10px;align-items:flex-start;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:12px;margin-bottom:16px;cursor:pointer">
      <input type="checkbox" id="no-refunds-ack" onchange="handleNoRefundsAck()" style="margin-top:2px;accent-color:#ef4444" />
      <span class="text-xs" style="color:var(--text2);line-height:1.5"><strong style="color:#ef4444">No refunds:</strong> I understand purchases are non-refundable for the current billing period. I can cancel anytime to stop future renewals.</span>
    </label>
    <div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime to stop future renewals. No refunds for the current billing period.</p>`
    )
    .replace(
      'function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')',
      `function handleNoRefundsAck() { if (pendingPlan) renderPayPal(pendingPlan) }
function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')
  const noRefundsAck = document.getElementById('no-refunds-ack')
  if (!noRefundsAck || !noRefundsAck.checked) {
    container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text3);border:1px dashed var(--border);border-radius:12px">Check the no-refunds acknowledgement above to continue to PayPal.</div>'
    return
  }`
    )
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
