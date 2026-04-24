import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import aiRoutes      from './routes/ai.js'
import authRoutes    from './routes/auth.js'
import paymentRoutes from './routes/payment.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 3000

// ── Gemini keys (supports up to 10) ────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
  process.env.GEMINI_API_KEY_7,
  process.env.GEMINI_API_KEY_8,
  process.env.GEMINI_API_KEY_9,
  process.env.GEMINI_API_KEY_10,
].filter(Boolean)

export { GEMINI_KEYS }

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use(express.static(join(__dirname, 'public')))

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    service:    'Thyroxeia AI Backend',
    version:    '2.0.0',
    geminiKeys: `${GEMINI_KEYS.length} key(s) configured`,
    supabase:   !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    paypal:     !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    smtp:       !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  })
})

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/ai',      aiRoutes)
app.use('/auth',    authRoutes)      // frontend uses BACKEND.AUTH_EMAIL = '/auth'
app.use('/payment', paymentRoutes)

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`🚀 Thyroxeia AI Backend v2 running on port ${PORT}`)
  console.log(`   Gemini keys: ${GEMINI_KEYS.length}`)
  console.log(`   SMTP:        ${!!(process.env.SMTP_HOST)}`)
  console.log(`   Supabase:    ${!!(process.env.SUPABASE_URL)}`)
  console.log(`   PayPal mode: ${process.env.PAYPAL_MODE || 'live'}`)
})
