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
  // Try to fetch the requested path from Cloudflare Assets
  const asset = await c.env.ASSETS.fetch(c.req.raw)
  
  // If the asset exists (200-299 status), return it
  if (asset.status >= 200 && asset.status < 300) {
    return asset
  }
  
  // For 404 or any other non-success, serve index.html for SPA routing
  const indexRequest = new Request(c.req.url.replace(/\?.*$/, '') + '/index.html', c.req)
  const indexAsset = await c.env.ASSETS.fetch(indexRequest)
  
  if (indexAsset.status >= 200 && indexAsset.status < 300) {
    return indexAsset
  }
  
  // Fallback: fetch index.html from root
  const rootIndex = await c.env.ASSETS.fetch(new Request(c.req.url.split('/')[0] + '//' + new URL(c.req.url).host + '/index.html', c.req))
  return rootIndex
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
