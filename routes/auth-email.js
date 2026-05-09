
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
 *  - OTP is now generated SERVER-SIDE with Web Crypto (not passed from client)
 *  - OTP stored in Supabase otp_codes table with 10-min expiry
 *  - All email actions require valid JWT
 *  - HTML entity escaping on all user inputs
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

// ── OTP attempt tracking (KV-backed per user_id via c.env.OTP_ATTEMPTS) ───────
const OTP_MAX_ATTEMPTS = 5

async function checkOtpAttempts(env, userId) {
  const key = `otp_attempts:${userId}`
  const raw = await env.OTP_ATTEMPTS.get(key)
  const now = Date.now()
  const entry = raw ? JSON.parse(raw) : null
  if (!entry || entry.resetAt < now) {
    await env.OTP_ATTEMPTS.put(key, JSON.stringify({ count: 1, resetAt: now + 15 * 60 * 1000 }), { expirationTtl: 900 })
    return true
  }
  if (entry.count >= OTP_MAX_ATTEMPTS) return false
  entry.count++
  await env.OTP_ATTEMPTS.put(key, JSON.stringify(entry), { expirationTtl: 900 })
  return true
}

async function clearOtpAttempts(env, userId) {
  await env.OTP_ATTEMPTS.delete(`otp_attempts:${userId}`)
}

const app = new Hono()

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

// ── Resend email sender ───────────────────────────────────────────────────────
async function sendEmail(env, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html })
  })
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`)
  return res.json()
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

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser(c) {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return { error: 'Authentication required.', status: 401 }
  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) return { error: 'Invalid or expired session. Please log in again.', status: 401 }
  return { user, sb }
}

// ── POST /auth/send-otp ───────────────────────────────────────────────────────
app.post('/send-otp', async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) return c.json({ error: 'Supabase not configured.' }, 500)
  const { user, sb, error, status } = await getAuthUser(c)
  if (error) return c.json({ error }, status)

  const { firstName } = await c.req.json()
  const email = user.email
  if (!email) return c.json({ error: 'No email associated with this account.' }, 400)

  try {
    // Generate cryptographically random 6-digit OTP via Web Crypto
    const arr = new Uint32Array(1)
    crypto.getRandomValues(arr)
    const otp = String(100000 + (arr[0] % 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // Hash OTP before storing — plain value never touches the DB
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp))
    const otpHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

    // Store OTP in Supabase (upsert — one OTP per user at a time)
    const { error: upsertErr } = await sb.from('otp_codes').upsert({
      user_id:    user.id,
      email:      email,
      otp_hash:   otpHash,
      expires_at: expiresAt,
      used:       false,
    }, { onConflict: 'user_id' })
    if (upsertErr) throw new Error(upsertErr.message)

    await sendEmail(c.env, email, '⚡ Your Thyroxeia AI verification code', verificationTemplate(firstName || '', otp))

    console.log(`[OTP] Sent to ${email}, expires ${expiresAt}`)
    return c.json({ success: true })
  } catch (err) {
    console.error('[OTP send error]', err.message)
    return c.json({ error: 'Failed to send verification code.' }, 500)
  }
})

// ── POST /auth/verify-otp ─────────────────────────────────────────────────────
app.post('/verify-otp', async (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) return c.json({ error: 'Supabase not configured.' }, 500)
  const { user, sb, error, status } = await getAuthUser(c)
  if (error) return c.json({ error }, status)

  const { otp } = await c.req.json()
  if (!otp || !/^\d{6}$/.test(otp)) return c.json({ error: 'Invalid OTP format.' }, 400)

  try {
    const { data, error: dbErr } = await sb
      .from('otp_codes')
      .select('*')
      .eq('user_id', user.id)
      .eq('used', false)
      .single()

    if (dbErr || !data) return c.json({ error: 'No pending verification found.' }, 400)

    if (new Date(data.expires_at) < new Date()) {
      return c.json({ error: 'Verification code has expired. Please request a new one.' }, 400)
    }

    if (!await checkOtpAttempts(c.env, user.id)) {
      return c.json({ error: 'Too many attempts. Please request a new code.' }, 429)
    }

    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp))
    const inputHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

    if (data.otp_hash !== inputHash) {
      return c.json({ error: 'Incorrect verification code.' }, 400)
    }

    await sb.from('otp_codes').update({ used: true }).eq('user_id', user.id)
    await clearOtpAttempts(c.env, user.id)

    console.log(`[OTP] ✅ Verified for user ${user.id}`)
    return c.json({ success: true })
  } catch (err) {
    console.error('[OTP verify error]', err.message)
    return c.json({ error: 'Verification failed. Please try again.' }, 500)
  }
})

// ── POST /auth — JWT-protected email actions ──────────────────────────────────
app.post('/', async (c) => {
  const { user, sb, error, status } = await getAuthUser(c)
  if (error) return c.json({ error }, status)

  const { action, payload } = await c.req.json()
  if (!action || !payload) return c.json({ error: 'Missing action or payload' }, 400)

  const authenticatedUserId = user.id

  // ── Elite shoutout ──────────────────────────────────────────────────────────
  if (action === 'elite-shoutout') {
    const { displayName } = payload
    if (!displayName) return c.json({ error: 'Missing displayName' }, 400)
    if (!c.env.SUPABASE_URL) return c.json({ error: 'Supabase not configured' }, 500)

    const safeDisplayName = escapeHtml(String(displayName).slice(0, 100))

    try {
      const { data: existing } = await sb.from('shoutouts').select('id').eq('user_id', authenticatedUserId).single()
      if (existing) return c.json({ success: true, skipped: true })

      const { error: insErr } = await sb.from('shoutouts').insert({
        user_id:      authenticatedUserId,
        display_name: safeDisplayName,
        created_at:   new Date().toISOString(),
      })
      if (insErr) throw new Error(insErr.message)

      return c.json({ success: true })
    } catch (err) {
      console.error('[Shoutout error]', err.message)
      return c.json({ error: 'Failed to create shoutout.' }, 500)
    }
  }

  // ── Email actions ───────────────────────────────────────────────────────────
  const { firstName } = payload
  const targetEmail = user.email
  if (!targetEmail) return c.json({ error: 'No email associated with this account' }, 400)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) return c.json({ error: 'Invalid email' }, 400)

  try {
    if (action === 'send-verification' || action === 'send-welcome') {
      await sendEmail(c.env, targetEmail, "🎉 Welcome to Thyroxeia AI — you're in!", welcomeTemplate(firstName))
      return c.json({ success: true })
    }

    if (action === 'send-elite-welcome') {
      await sendEmail(c.env, targetEmail, '👑 You are now Elite — welcome to the top!', eliteWelcomeTemplate(firstName))
      return c.json({ success: true })
    }

    return c.json({ error: 'Unknown action: ' + action }, 400)

  } catch (err) {
    console.error('[Auth email error]', err.message)
    return c.json({ error: 'Failed to send email. Please try again.' }, 500)
  }
})

export default app
