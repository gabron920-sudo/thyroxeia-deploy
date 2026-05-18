import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai-clean.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin-clean2.js'

const app = new Hono()
const DEFAULT_ALLOWED_ORIGINS = ['https://thyroxeia.fancy-sky-31cf.workers.dev']

// Lightweight per-isolate emergency throttles. Per-user daily limits are still enforced in routes/ai-clean.js.
// For durable IP/global limits, add Supabase tables or Cloudflare KV/Durable Object later.
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
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

app.use('/ai/*', async (c, next) => {
  const ipLimit = Number(c.env.AI_IP_HOURLY_LIMIT || 60)
  const globalLimit = Number(c.env.AI_GLOBAL_DAILY_LIMIT || 3000)
  const ip = getIp(c)
  const ipCount = bump(ipWindow, `${hourKey()}:${ip}`)
  const globalCount = bump(globalWindow, todayKey())
  if (ipCount > ipLimit) return c.json({ error: 'Too many AI requests from this network. Please try again later.', ipHourlyLimit: ipLimit }, 429)
  if (globalCount > globalLimit) return c.json({ error: 'Daily AI capacity reached. Please try again later.', globalDailyLimit: globalLimit }, 429)
  return next()
})

app.route('/ai', aiRouter)
app.route('/auth', authRouter)
app.route('/payment', paymentRouter)
app.route('/admin', adminRouter)

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
