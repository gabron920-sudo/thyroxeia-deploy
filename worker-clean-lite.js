import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai-clean-lite.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin-clean-lite.js'

const app = new Hono()
const DEFAULT_ALLOWED_ORIGINS = ['https://thyroxeia.fancy-sky-31cf.workers.dev']

// Emergency per-isolate throttles only. These Maps reset whenever the Worker
// isolate is recycled, so they are a backstop, NOT a real limit. The durable
// limits are: (a) the per-user daily quota in Supabase (routes/ai-clean-lite.js),
// and (b) Cloudflare's Rate Limiting binding (AI_RATE_LIMITER) when configured —
// see SECURITY-FIXES.md for the wrangler config.
const ipWindow = new Map()
const globalWindow = new Map()
function todayKey() { return new Date().toISOString().slice(0, 10) }
function hourKey() { return new Date().toISOString().slice(0, 13) }
function getIp(c) {
  return c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}
function bump(map, key) {
  const val = (map.get(key) || 0) + 1
  map.set(key, val)
  return val
}

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(',')).split(',').map(o => o.trim()).filter(Boolean)
    if (!origin) return origin
    return allowed.includes(origin) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info', 'Prefer', 'Accept', 'Accept-Profile', 'Content-Profile'],
  maxAge: 86400,
}))

// Durable limiters (Cloudflare Rate Limiting bindings) when configured. Unlike the
// in-memory Maps, these are shared across every isolate and survive restarts.
async function durableLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return null
  try {
    const { success } = await limiter.limit({ key })
    return success !== false
  } catch (err) {
    console.warn('[RateLimit] binding error:', err?.message || err)
    return null
  }
}

const aiRateGuard = async (c, next) => {
  const ipLimit = Number(c.env.AI_IP_HOURLY_LIMIT || 60)
  const globalLimit = Number(c.env.AI_GLOBAL_DAILY_LIMIT || 3000)
  const ip = getIp(c)

  const ipOk = await durableLimit(c.env.AI_IP_LIMITER, `ip:${ip}`)
  const globalOk = await durableLimit(c.env.AI_GLOBAL_LIMITER, 'global')

  if (ipOk === false) {
    return c.json({ error: 'Too many AI requests from this network. Please try again later.' }, 429)
  }
  if (globalOk === false) {
    return c.json({ error: 'Daily AI capacity reached. Please try again later.' }, 429)
  }

  // Fallback only when the binding is not configured (see SECURITY-FIXES.md).
  if (ipOk === null) {
    const ipCount = bump(ipWindow, `${hourKey()}:${ip}`)
    if (ipCount > ipLimit) return c.json({ error: 'Too many AI requests from this network. Please try again later.', ipHourlyLimit: ipLimit }, 429)
  }
  if (globalOk === null) {
    const globalCount = bump(globalWindow, todayKey())
    if (globalCount > globalLimit) return c.json({ error: 'Daily AI capacity reached. Please try again later.', globalDailyLimit: globalLimit }, 429)
  }

  return next()
}

// Register for BOTH /ai and /ai/* — a Hono wildcard on '/ai/*' does not match the
// bare '/ai' path that the app actually POSTs to, so the guard used to be skipped.
app.use('/ai', aiRateGuard)
app.use('/ai/*', aiRateGuard)

app.route('/ai', aiRouter)
app.route('/auth', authRouter)
app.route('/payment', paymentRouter)
app.route('/admin', adminRouter)

// ── Supabase proxy ───────────────────────────────────────────────────────────
// Keeps the project URL and the anon key out of the browser. The client calls
// /sb/auth/v1/* and /sb/rest/v1/* on this origin; the anon key is injected here.
// The service-role key is NEVER used on this path and the caller's Authorization
// header is passed through untouched, so Row Level Security still applies to
// every single request.
app.all('/sb/*', async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_ANON_KEY) {
    return c.json({ error: 'Supabase proxy is not configured.' }, 500)
  }

  const incoming = new URL(c.req.url)
  const path = incoming.pathname.replace(/^\/sb/, '')
  if (!/^\/(auth|rest)\/v1\//.test(path)) return c.json({ error: 'Not found' }, 404)

  const target = new URL(c.env.SUPABASE_URL.replace(/\/$/, '') + path + incoming.search)

  const headers = new Headers(c.req.raw.headers)
  headers.delete('host')
  headers.delete('apikey')
  headers.set('apikey', c.env.SUPABASE_ANON_KEY)

  // The browser only holds a placeholder key, so supabase-js sends
  // "Authorization: Bearer public-anon-key". Replace anything that is not a real
  // user JWT (JWTs start with "eyJ") with the anon key; forward real sessions as-is
  // so RLS still sees the user identity.
  const auth = headers.get('authorization') || ''
  if (!/^Bearer\s+eyJ/.test(auth)) headers.set('authorization', `Bearer ${c.env.SUPABASE_ANON_KEY}`)

  const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.arrayBuffer()

  let upstream
  try {
    upstream = await fetch(target.toString(), {
      method: c.req.method,
      headers,
      body,
      redirect: 'manual',
    })
  } catch (err) {
    console.error('[SB proxy] upstream error:', err?.message || err)
    return c.json({ error: 'Upstream unavailable.' }, 502)
  }

  const out = new Headers(upstream.headers)
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) out.delete(h)
  return new Response(upstream.body, { status: upstream.status, headers: out })
})

app.get('/api/paypal-config', (c) => c.json({
  clientId: c.env.PAYPAL_CLIENT_ID,
  mode: c.env.PAYPAL_MODE ?? 'live',
  currency: 'PHP',
  intent: 'subscription',
  vault: true,
}))

app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

app.get('*', async (c) => {
  const url = new URL(c.req.url)
  const spaRoutes = new Set(['/decks', '/create', '/dashboard', '/study', '/settings', '/upgrade', '/analytics', '/ai-tutor', '/tutor', '/login', '/signup', '/verify'])
  if (spaRoutes.has(url.pathname)) return c.redirect('/?from=' + encodeURIComponent(url.pathname), 302)
  try {
    const asset = await c.env.ASSETS.fetch(c.req.raw)
    if (asset.status >= 200 && asset.status < 300) return asset
  } catch (err) { console.warn('[Assets] direct asset fetch failed:', err?.message || err) }
  try {
    const indexUrl = new URL(c.req.url)
    indexUrl.pathname = '/index.html'
    indexUrl.search = ''
    return await c.env.ASSETS.fetch(new Request(indexUrl.toString(), { method: 'GET' }))
  } catch (err) {
    console.error('[Assets] index fallback failed:', err?.message || err)
    return c.text('App temporarily unavailable. Please refresh.', 503)
  }
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))
export default app
