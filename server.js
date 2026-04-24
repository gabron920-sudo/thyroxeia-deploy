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

// ── CORS — allow same-origin (frontend served from here) + any listed FRONTEND_URL
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    const allowed = new Set([
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
    ].filter(Boolean))
    if (allowed.has(origin)) return cb(null, true)
    if (origin.endsWith('.railway.app') || origin.endsWith('.up.railway.app')) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.options('*', cors())
app.use(express.json({ limit: '2mb' }))

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/ai',      aiRouter)
app.use('/payment', paymentRouter)
app.use('/auth',    authRouter)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const geminiKeys = [1,2,3,4,5].filter(i => process.env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
  res.json({
    status: 'ok',
    service: 'Thyroxeia AI Backend',
    version: '1.0.0',
    geminiKeys: `${geminiKeys.length} key(s) configured`,
    supabase: !!process.env.SUPABASE_SERVICE_KEY,
    paypal: !!process.env.PAYPAL_CLIENT_SECRET,
    smtp: !!process.env.SMTP_USER,
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
    // Get all profiles (plan info + payment proof)
    const { data: profiles, error: pErr } = await sb
      .from('profiles')
      .select('id, plan, paypal_order_id, plan_activated_at')
      .order('plan_activated_at', { ascending: false, nullsFirst: false })
    if (pErr) throw new Error(pErr.message)

    // Get auth users (email + last login)
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

    // Count by plan
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
  res.status(500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`✅ Thyroxeia running on port ${PORT}`)
  console.log(`🌐 Frontend served at http://localhost:${PORT}`)

  const geminiKeys = [1,2,3,4,5]
    .map(i => process.env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    .filter(Boolean)
  if (!geminiKeys.length) console.warn('⚠️  No GEMINI_API_KEY found — AI calls will fail!')
  else console.log(`✅ Gemini key pool: ${geminiKeys.length} key(s) — round-robin active`)

  if (!process.env.PAYPAL_CLIENT_SECRET) console.warn('⚠️  PAYPAL_CLIENT_SECRET not set — payments will fail!')
  else console.log('✅ PayPal live credentials configured')

  if (!process.env.SUPABASE_SERVICE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY not set!')
  else console.log('✅ Supabase service key configured')

  if (!process.env.SMTP_USER) console.warn('⚠️  SMTP not configured — branded emails will fail!')
  else console.log('✅ SMTP configured')

  if (!process.env.ADMIN_KEY) console.warn('⚠️  ADMIN_KEY not set — /admin endpoints will be inaccessible')
  else console.log('✅ Admin endpoints secured')
})
