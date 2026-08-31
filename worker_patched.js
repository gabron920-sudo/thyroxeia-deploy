import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'

const app = new Hono()

// CORS — still handy if you ever embed from another domain
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// API routes
app.route('/ai',      aiRouter)
app.route('/auth',    authRouter)
app.route('/payment', paymentRouter)

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

async function serveIndex(c) {
  const url = new URL(c.req.url)
  url.pathname = '/index.html'
  url.search = ''

  // Do not clone the already-used incoming Request. Build a clean GET request
  // so SPA routes like /verify, /login, /dashboard reliably return index.html.
  return c.env.ASSETS.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  }))
}

// Explicit SPA frontend routes. This avoids Workers Assets returning 500s for
// direct navigations to routes that do not physically exist as files.
const frontendRoutes = [
  '/',
  '/verify',
  '/login',
  '/signup',
  '/dashboard',
  '/app',
  '/checkout',
  '/upgrade',
]

for (const route of frontendRoutes) {
  app.get(route, serveIndex)
}

// Serve static assets first, then fall back to /index.html for SPA routes.
app.get('*', async (c) => {
  try {
    const asset = await c.env.ASSETS.fetch(new Request(c.req.url, {
      method: 'GET',
      headers: c.req.raw.headers,
    }))

    if (asset.status >= 200 && asset.status < 300) {
      return asset
    }
  } catch (err) {
    console.warn('[Assets] direct asset fetch failed:', err?.message || err)
  }

  return serveIndex(c)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
