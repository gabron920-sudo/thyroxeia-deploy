import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai-clean.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin.js'

const app = new Hono()

const DEFAULT_ALLOWED_ORIGINS = [
  'https://thyroxeia.fancy-sky-31cf.workers.dev',
]

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)
    if (!origin) return origin
    return allowed.includes(origin) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

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
  try {
    const asset = await c.env.ASSETS.fetch(c.req.raw)
    if (asset.status >= 200 && asset.status < 300) return asset
  } catch (err) {
    console.warn('[Assets] direct asset fetch failed:', err?.message || err)
  }
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  url.search = ''
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
