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
      connectSrc:     ["'self'", "https://*.supabase.co", "wss://*.supabase.co", "https://api-m.paypal.com", "https://api-m.sandbox.paypal.com", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
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
  crossOriginEmbedderPolicy: false,
}))

const ALLOWED_ORIGINS = new Set([
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://thyroxeia-deploy-production.up.railway.app',
].filter(Boolean))

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    cb(new Error("CORS not allowed"))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '2mb' }))

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests' },
})
app.use(globalLimiter)

app.use('/ai', aiRouter)
app.use('/payment', paymentRouter)
app.use('/auth', authRouter)

app.get('/health', (req, res) => res.json({ status: 'ok' }))

const publicDir = join(__dirname, 'public')
app.use(express.static(publicDir))
app.get('*', (req, res) => res.sendFile(join(publicDir, 'index.html')))

app.listen(PORT, () => console.log('Server running'))
