/**
 * /auth  — Branded emails + Elite shoutout handler
 *
 * POST /auth
 * Actions:
 *   send-verification  → generates OTP server-side, stores in Supabase, emails it
 *   verify-otp         → verifies the OTP server-side (no client-side bypass possible)
 *   send-welcome       → welcome email after verify (requires valid JWT)
 *   send-elite-welcome → elite welcome email (requires valid JWT)
 *   elite-shoutout     → insert shoutout row (requires valid JWT, userId from token)
 *
 * SECURITY FIXES:
 *  - OTP is now generated server-side with crypto.randomInt (not passed from client)
 *  - OTP stored in Supabase otp_codes table with 10-min expiry
 *  - All email actions require valid JWT
 *  - HTML entity escaping on all user inputs
 */

import { Router }     from 'express'
import nodemailer     from 'nodemailer'
import { createClient } from '@supabase/supabase-js'
import { randomInt, createHash } from 'crypto'

// ── OTP attempt tracking (in-memory, per user_id) ─────────────────────────────
const otpAttempts = new Map() // user_id → { count, resetAt }
const OTP_MAX_ATTEMPTS = 5
function checkOtpAttempts(userId) {
  const now = Date.now()
  const entry = otpAttempts.get(userId)
  if (!entry || entry.resetAt < now) {
    otpAttempts.set(userId, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (entry.count >= OTP_MAX_ATTEMPTS) return false
  entry.count++
  return true
}
function clearOtpAttempts(userId) { otpAttempts.delete(userId) }

const router = Router()

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── JWT Auth Middleware ───────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required.' })
  if (!sb) return res.status(500).json({ error: 'Auth service not configured.' })

  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })

  req.user = user
  next()
}

// ── HTML entity escape ────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof str !== 'string') return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
}

let _transporter = null
function getTransporter() {
  if (_transporter) return _transporter
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP not configured')
  }
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  return _transporter
}

// ── Email templates ───────────────────────────────────────────────────────────
function verificationTemplate(firstName, otp) {
  const safeName = escapeHtml(firstName)
  const safeOtp  = escapeHtml(String(otp || ''))
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif;color:#f1f5f9}
  .wrap{max-width:520px;margin:40px auto;background:#12121a;border:1px solid #1e293b;border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#7c3aed,#a855f7);padding:36px 40px;text-align:center}
  .header h1{margin:0;font-size:1.6rem;font-weight:800;color:#fff}
  .body{padding:36px 40px}
  .otp-box{background:#1a1a2e;border:2px solid #7c3aed;border-radius:12px;padding:20px;text-align:center;margin:24px 0}
  .otp-code{font-size:2.8rem;font-weight:900;letter-spacing:.25em;color:#c084fc;font-family:monospace}
  .footer{padding:20px 40px;border-top:1px solid #1e293b;font-size:.78rem;color:#64748b;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>⚡ Thyroxeia AI</h1><p style="margin:6px 0 0;color:rgba(255,255,255,.8);font-size:.9rem">Study Smarter with AI</p></div>
  <div class="body">
    <p style="font-size:1.05rem;font-weight:600">Hi ${safeName || 'there'}! 👋</p>
    <p style="color:#94a3b8;margin-top:8px">Enter this 6-digit code to verify your email:</p>
    <div class="otp-box">
      <div class="otp-code">${safeOtp || '——————'}</div>
      <div style="font-size:.8rem;color:#64748b;margin-top:10px">Expires in 10 minutes</div>
    </div>
    <p style="color:#64748b;font-size:.875rem">Didn't sign up? Ignore this email.</p>
  </div>
  <div class="footer">© ${new Date().getFullYear()} Thyroxeia AI</div>
</div>
</body></html>`
}

function welcomeTemplate(firstName) {
  const safeName = escapeHtml(firstName)
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif;color:#f1f5f9}
  .wrap{max-width:520px;margin:40px auto;background:#12121a;border:1px solid #1e293b;border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#7c3aed,#a855f7);padding:36px 40px;text-align:center}
  .header h1{margin:0;font-size:1.6rem;font-weight:800;color:#fff}
  .body{padding:36px 40px}
  .feature{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
  .footer{padding:20px 40px;border-top:1px solid #1e293b;font-size:.78rem;color:#64748b;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>🎉 Welcome to Thyroxeia AI!</h1></div>
  <div class="body">
    <p style="font-size:1.05rem;font-weight:600">You're in, ${safeName || 'friend'}!</p>
    <p style="color:#94a3b8;margin:8px 0 24px">Your email is verified. Here's what's waiting:</p>
    <div class="feature"><span style="font-size:1.5rem">🃏</span><div><strong>AI Flashcard Generator</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Paste notes or a topic — Gemini builds your deck in seconds.</p></div></div>
    <div class="feature"><span style="font-size:1.5rem">🧠</span><div><strong>6 Study Modes</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Flashcards, Quiz, Timed Test, Type Answer, Match, Study Guide.</p></div></div>
    <div class="feature"><span style="font-size:1.5rem">🤖</span><div><strong>AI Tutor Chat</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Ask anything. Your personal Gemini-powered tutor is always on.</p></div></div>
    <div class="feature"><span style="font-size:1.5rem">🎮</span><div><strong>XP &amp; Streaks</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Earn XP, build streaks, level up as you study.</p></div></div>
  </div>
  <div class="footer">© ${new Date().getFullYear()} Thyroxeia AI · You signed up — welcome! 🎉</div>
</div>
</body></html>`
}

function eliteWelcomeTemplate(firstName) {
  const safeName = escapeHtml(firstName)
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#0a0a0f;font-family:Arial,sans-serif;color:#f1f5f9}
  .wrap{max-width:520px;margin:40px auto;background:#12121a;border:2px solid rgba(245,158,11,.4);border-radius:16px;overflow:hidden}
  .header{background:linear-gradient(135deg,#b45309,#f59e0b,#fcd34d);padding:36px 40px;text-align:center}
  .header h1{margin:0;font-size:1.6rem;font-weight:900;color:#1a1a00}
  .body{padding:36px 40px}
  .perk{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px 16px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px}
  .footer{padding:20px 40px;border-top:1px solid rgba(245,158,11,.2);font-size:.78rem;color:#92400e;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>👑 Welcome to Elite!</h1><p style="margin:6px 0 0;font-weight:600;color:#78350f">You're now part of the top tier.</p></div>
  <div class="body">
    <p style="font-size:1.05rem;font-weight:600">Congratulations, ${safeName || 'Champion'}! 🏆</p>
    <p style="color:#94a3b8;margin:8px 0 24px">Your Elite plan is now active. Here's what you unlocked:</p>
    <div class="perk"><span style="font-size:1.3rem">⚡</span><div><strong>Everything in Pro</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">50 AI calls/day, unlimited decks, all study modes.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">🌟</span><div><strong>Gold Username Badge</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Your name appears in gold across the platform.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">📢</span><div><strong>Server-Wide Shoutout</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Every user sees your welcome announcement when they log in.</p></div></div>
    <div class="perk"><span style="font-size:1.3rem">🎯</span><div><strong>Priority Support</strong><p style="color:#94a3b8;font-size:.85rem;margin:2px 0 0">Your support tickets jump to the front of the queue.</p></div></div>
  </div>
  <div class="footer">© ${new Date().getFullYear()} Thyroxeia AI Elite · Thank you for your support 👑</div>
</div>
</body></html>`
}

// ── POST /auth/send-otp ───────────────────────────────────────────────────────
// FIX: OTP is now generated SERVER-SIDE. Client never sees or sends the OTP value.
// Requires JWT auth — OTP is emailed to the authenticated user's own email.
router.post('/send-otp', requireAuth, async (req, res) => {
  if (!sb) return res.status(500).json({ error: 'Supabase not configured.' })
  const { firstName } = req.body || {}
  const email = req.user.email
  if (!email) return res.status(400).json({ error: 'No email associated with this account.' })

  try {
    // Generate cryptographically random 6-digit OTP
    const otp = String(randomInt(100000, 999999))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes

    // Hash OTP before storing — plain value never touches the DB
    const otpHash = createHash('sha256').update(otp).digest('hex')

    // Store OTP in Supabase (upsert — one OTP per user at a time)
    const { error: upsertErr } = await sb.from('otp_codes').upsert({
      user_id:    req.user.id,
      email:      email,
      otp_hash:   otpHash,
      expires_at: expiresAt,
      used:       false,
    }, { onConflict: 'user_id' })

    if (upsertErr) throw new Error(upsertErr.message)

    // Send branded email
    const transporter = getTransporter()
    const FROM = process.env.EMAIL_FROM || `Thyroxeia AI <${process.env.SMTP_USER}>`
    await transporter.sendMail({
      from: FROM, to: email,
      subject: '⚡ Your Thyroxeia AI verification code',
      html: verificationTemplate(firstName || '', otp),
    })

    console.log(`[OTP] Sent to ${email}, expires ${expiresAt}`)
    return res.json({ success: true })
  } catch (err) {
    console.error('[OTP send error]', err.message)
    return res.status(500).json({ error: 'Failed to send verification code.' })
  }
})

// ── POST /auth/verify-otp ─────────────────────────────────────────────────────
// FIX: Verifies OTP server-side — no client-side bypass possible
router.post('/verify-otp', requireAuth, async (req, res) => {
  if (!sb) return res.status(500).json({ error: 'Supabase not configured.' })
  const { otp } = req.body || {}
  if (!otp || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Invalid OTP format.' })

  try {
    const { data, error } = await sb
      .from('otp_codes')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('used', false)
      .single()

    if (error || !data) return res.status(400).json({ error: 'No pending verification found.' })

    // Check expiry
    if (new Date(data.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' })
    }

    // Rate-limit OTP attempts
    if (!checkOtpAttempts(req.user.id)) {
      return res.status(429).json({ error: 'Too many attempts. Please request a new code.' })
    }

    // Check OTP value (compare against stored hash)
    const inputHash = createHash('sha256').update(otp).digest('hex')
    if (data.otp_hash !== inputHash) {
      return res.status(400).json({ error: 'Incorrect verification code.' })
    }

    // Mark as used & clear attempt counter
    await sb.from('otp_codes').update({ used: true }).eq('user_id', req.user.id)
    clearOtpAttempts(req.user.id)

    console.log(`[OTP] ✅ Verified for user ${req.user.id}`)
    return res.json({ success: true })
  } catch (err) {
    console.error('[OTP verify error]', err.message)
    return res.status(500).json({ error: 'Verification failed. Please try again.' })
  }
})

// ── POST /auth — JWT-protected email actions ──────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { action, payload } = req.body || {}
  if (!action || !payload) return res.status(400).json({ error: 'Missing action or payload' })

  const authenticatedUserId = req.user.id

  // ── Elite shoutout ──────────────────────────────────────────────────────────
  if (action === 'elite-shoutout') {
    const { displayName } = payload
    if (!displayName) return res.status(400).json({ error: 'Missing displayName' })
    if (!sb) return res.status(500).json({ error: 'Supabase not configured' })

    const safeDisplayName = escapeHtml(String(displayName).slice(0, 100))

    try {
      const { data: existing } = await sb.from('shoutouts').select('id').eq('user_id', authenticatedUserId).single()
      if (existing) {
        return res.json({ success: true, skipped: true })
      }

      const { error } = await sb.from('shoutouts').insert({
        user_id:      authenticatedUserId,
        display_name: safeDisplayName,
        created_at:   new Date().toISOString(),
      })
      if (error) throw new Error(error.message)

      return res.json({ success: true })
    } catch (err) {
      console.error('[Shoutout error]', err.message)
      return res.status(500).json({ error: 'Failed to create shoutout.' })
    }
  }

  // ── Email actions ───────────────────────────────────────────────────────────
  const { firstName } = payload
  const targetEmail = req.user.email  // always from JWT
  if (!targetEmail) return res.status(400).json({ error: 'No email associated with this account' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) return res.status(400).json({ error: 'Invalid email' })

  try {
    const transporter = getTransporter()
    const FROM = process.env.EMAIL_FROM || `Thyroxeia AI <${process.env.SMTP_USER}>`

    // Alias: send-verification is the same as send-welcome (called on signup)
    if (action === 'send-verification' || action === 'send-welcome') {
      await transporter.sendMail({
        from: FROM, to: targetEmail,
        subject: "🎉 Welcome to Thyroxeia AI — you're in!",
        html: welcomeTemplate(firstName),
      })
      return res.json({ success: true })
    }

    if (action === 'send-elite-welcome') {
      await transporter.sendMail({
        from: FROM, to: targetEmail,
        subject: '👑 You are now Elite — welcome to the top!',
        html: eliteWelcomeTemplate(firstName),
      })
      return res.json({ success: true })
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    console.error('[Auth email error]', err.message)
    res.status(500).json({ error: 'Failed to send email. Please try again.' })
  }
})

export default router
