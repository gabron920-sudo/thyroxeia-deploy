/**
 * Thyroxeia AI — Backend Server
 * Handles: AI proxy (Gemini), PayPal payments, branded auth emails
 * Also serves the frontend HTML from /public
 */

import 'dotenv/config'
import express       from 'express'
import cors          from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import aiRouter      from './routes/ai.js'
import paymentRouter from './routes/payment.js'
import authRouter    from './routes/auth-email.js'

const app  = express()
const PORT = process.env.PORT || 3001
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CORS — allow same-origin (frontend served from here) + any listed FRONTEND_URL
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests (from the served HTML) have no origin header — always allow
    if (!origin) return cb(null, true)
    const allowed = new Set([
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
    ].filter(Boolean))
    if (allowed.has(origin)) return cb(null, true)
    // Also allow any *.railway.app origin (for the self-hosted frontend)
    if (origin.endsWith('.railway.app') || origin.endsWith('.up.railway.app')) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.options('*', cors())
app.use(express.json({ limit: '2mb' }))

// ── API Routes (must be before static, so /ai /payment /auth are never masked) ──
app.use('/ai',      aiRouter)
app.use('/payment', paymentRouter)
app.use('/auth',    authRouter)

// ── Health check (JSON) ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'Thyroxeia AI Backend',
  version: '1.0.0',
  geminiKeys: (() => {
    const keys = [1,2,3,4,5].filter(i => process.env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    return `${keys.length} key(s) configured`
  })(),
}))

// ── Serve frontend (HTML + any static assets in /public) ──────────────────────
const publicDir = join(__dirname, 'public')
app.use(express.static(publicDir))

// SPA fallback — any unmatched GET returns index.html
app.get('*', (_req, res) => {
  res.sendFile(join(publicDir, 'index.html'))
})

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`✅ Thyroxeia running on port ${PORT}`)
  console.log(`🌐 Frontend served at http://localhost:${PORT}`)

  const geminiKeys = [1,2,3,4,5]
    .map(i => process.env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    .filter(Boolean)
  if (!geminiKeys.length) console.warn('⚠️  No GEMINI_API_KEY found — AI calls will fail!')
  else console.log(`✅ Gemini key pool: ${geminiKeys.length} key(s)`)

  if (!process.env.PAYPAL_CLIENT_SECRET) console.warn('⚠️  PAYPAL_CLIENT_SECRET not set — payments will fail!')
  else console.log('✅ PayPal credentials configured')

  if (!process.env.SUPABASE_SERVICE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY not set!')
  else console.log('✅ Supabase service key configured')

  if (!process.env.SMTP_USER) console.warn('⚠️  SMTP not configured — branded emails will fail!')
  else console.log('✅ SMTP configured')
})
