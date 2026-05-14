import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

app.route('/ai', aiRouter)
app.route('/auth', authRouter)
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

async function serveAsset(c, pathname) {
  const url = new URL(c.req.url)
  url.pathname = pathname
  url.search = ''
  return c.env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }))
}

async function serveIndex(c) {
  return serveAsset(c, '/index.html')
}

const frontendRoutes = ['/', '/verify', '/login', '/signup', '/dashboard', '/app', '/checkout', '/upgrade']
for (const route of frontendRoutes) {
  app.get(route, serveIndex)
}

app.get('*', async (c) => {
  const url = new URL(c.req.url)
  const pathname = url.pathname

  // If it looks like a static asset, try it first.
  if (pathname.includes('.')) {
    try {
      const asset = await serveAsset(c, pathname)
      if (asset.status >= 200 && asset.status < 300) return asset
    } catch (err) {
      console.warn('[Assets] static asset fetch failed:', err?.message || err)
    }
  }

  // Otherwise it is a frontend route for the SPA.
  return serveIndex(c)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
