/**
 * Thyroxeia AI — Backend Server
 * Handles: AI proxy (Gemini), PayPal payments, branded auth emails
 * Also serves the frontend HTML from /public
 */

import 'dotenv/config'
import express       from 'express'
import cors          from 'cors'
import helmet        from 'helmet'
import rateLimit     from 'express-rate-limit'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'

import aiRouter      from './routes/ai.js'
import paymentRouter from './routes/payment.js'
import authRouter    from './routes/auth-email.js'

const app  = express()
const PORT = process.env.PORT || 3001
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Supabase admin client ─────────────────────────────────────────────────────
const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── Security Headers (Helmet) ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:", "https:"],
      connectSrc:     ["'self'", "https://*.supabase.co", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
      frameSrc:       ["https://www.paypal.com", "https://www.sandbox.paypal.com"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: false,
  crossOriginEmbedderPolicy: false, // needed for PayPal iframes
}))

// ── CORS — locked to your specific origins only ───────────────────────────────
const ALLOWED_ORIGINS = new Set([
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://thyroxeia-deploy-production.up.railway.app',
].filter(Boolean))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true) // same-origin / server-to-server
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.options('*', cors())
app.use(express.json({ limit: '2mb' }))

// ── Global Rate Limiters ──────────────────────────────────────────────────────
// General limiter — all routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
})

// Strict limiter for auth/email (prevent spam)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many email requests. Please wait before trying again.' },
})

// Payment limiter
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please wait.' },
})

app.use(globalLimiter)

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/ai',      aiRouter)
app.use('/payment', paymentLimiter, paymentRouter)
app.use('/auth',    authLimiter, authRouter)

// ── Health check — no sensitive data exposed ──────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Thyroxeia AI Backend',
    version: '1.0.0',
  })
})

// ── Admin: view users + payment proof (requires X-Admin-Key header) ───────────
app.get('/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden — invalid admin key' })
  }
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })

  try {
    const { data: profiles, error: pErr } = await sb
      .from('profiles')
      .select('id, plan, paypal_order_id, plan_activated_at')
      .order('plan_activated_at', { ascending: false, nullsFirst: false })
    if (pErr) throw new Error(pErr.message)

    const { data: authData, error: aErr } = await sb.auth.admin.listUsers({ perPage: 1000 })
    if (aErr) throw new Error(aErr.message)

    const userMap = {}
    for (const u of (authData?.users || [])) userMap[u.id] = u

    const users = (profiles || []).map(p => ({
      id:               p.id,
      email:            userMap[p.id]?.email || '—',
      plan:             p.plan || 'free',
      paypal_order_id:  p.paypal_order_id || null,
      plan_activated_at: p.plan_activated_at || null,
      last_sign_in:     userMap[p.id]?.last_sign_in_at || null,
      created_at:       userMap[p.id]?.created_at || null,
    }))

    const summary = users.reduce((acc, u) => {
      acc[u.plan] = (acc[u.plan] || 0) + 1
      return acc
    }, {})

    res.json({ total: users.length, summary, users })
  } catch (err) {
    console.error('[Admin users error]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: AI usage stats ─────────────────────────────────────────────────────
app.get('/admin/usage', async (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden — invalid admin key' })
  }
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })

  try {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await sb
      .from('ai_usage')
      .select('user_id, model, created_at')
      .gte('created_at', `${today}T00:00:00.000Z`)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)

    res.json({ date: today, total_calls_today: data?.length || 0, calls: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Serve frontend ────────────────────────────────────────────────────────────
const publicDir = join(__dirname, 'public')
app.use(express.static(publicDir))

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(join(publicDir, 'index.html'))
})

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`✅ Thyroxeia running on port ${PORT}`)
  console.log(`🌐 Frontend served at http://localhost:${PORT}`)
  console.log(`🔒 Security headers: Helmet enabled`)
  console.log(`🚦 Rate limiting: active`)
})
