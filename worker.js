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
  c.json({ clientId: c.env.PAYPAL_CLIENT_ID, mode: c.env.PAYPAL_MODE ?? 'live' })
)
app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

// Serve index.html for everything else (SPA catch-all)
app.get('*', async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw)
  return asset
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
