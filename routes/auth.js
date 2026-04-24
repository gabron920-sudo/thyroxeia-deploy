/**
 * /auth — Transactional emails + Elite shoutouts
 *
 * Uses Gmail SMTP via Nodemailer (set SMTP_* env vars in Railway)
 * Also handles profile creation on first signup
 */

import { Router }       from 'express'
import { createClient } from '@supabase/supabase-js'
import nodemailer       from 'nodemailer'

const router = Router()

const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── SMTP transporter ─────────────────────────────────────────────────────────
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP not configured')
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  })
}

async function sendEmail({ to, subject, html }) {
  const transporter = getTransporter()
  const from = process.env.SMTP_FROM || `Thyroxeia AI <${process.env.SMTP_USER}>`
  await transporter.sendMail({ from, to, subject, html })
}

// ── Branded email templates ───────────────────────────────────────────────────
const BASE_STYLE = `
  font-family: 'Segoe UI', Arial, sans-serif;
  background: #0a0a0f;
  color: #f1f5f9;
  max-width: 600px;
  margin: 0 auto;
  border-radius: 16px;
  overflow: hidden;
`
const HEADER = `
  <div style="background: linear-gradient(135deg, #7c3aed, #a855f7); padding: 32px; text-align: center;">
    <h1 style="margin:0; color:#fff; font-size: 28px;">⚡ Thyroxeia AI</h1>
    <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size: 14px;">Study Smarter with Gemini AI</p>
  </div>
`
const FOOTER = `
  <div style="background:#12121a; padding:24px; text-align:center; color:#64748b; font-size:12px;">
    <p style="margin:0;">© 2025 Thyroxeia AI · All rights reserved</p>
    <p style="margin:4px 0 0;">Questions? Reply to this email.</p>
  </div>
`

function verifyTemplate(firstName, otp) {
  return `<div style="${BASE_STYLE}">
    ${HEADER}
    <div style="background:#12121a; padding:40px 32px;">
      <h2 style="color:#a855f7; margin:0 0 16px;">Verify your email</h2>
      <p style="color:#94a3b8; margin:0 0 24px;">Hi ${firstName || 'there'}! Enter this code to confirm your Thyroxeia AI account:</p>
      <div style="background:#1a1a2e; border:2px solid #7c3aed; border-radius:12px; padding:24px; text-align:center; margin:0 0 24px;">
        <span style="font-size:40px; font-weight:900; letter-spacing:12px; color:#a855f7;">${otp}</span>
      </div>
      <p style="color:#64748b; font-size:13px; margin:0;">This code expires in 10 minutes. If you didn't sign up, ignore this email.</p>
    </div>
    ${FOOTER}
  </div>`
}

function welcomeTemplate(firstName) {
  return `<div style="${BASE_STYLE}">
    ${HEADER}
    <div style="background:#12121a; padding:40px 32px;">
      <h2 style="color:#10b981; margin:0 0 16px;">Welcome to Thyroxeia AI! 🎉</h2>
      <p style="color:#94a3b8; margin:0 0 16px;">Hi ${firstName || 'there'}! Your account is verified and ready.</p>
      <p style="color:#94a3b8; margin:0 0 24px;">Start by creating your first flashcard deck with AI. Your free plan includes:</p>
      <ul style="color:#94a3b8; margin:0 0 24px; padding-left:20px; line-height:2;">
        <li>5 AI calls per day</li>
        <li>Flashcard, Quiz, Match &amp; Timed modes</li>
        <li>AI Tutor Chat</li>
      </ul>
      <a href="https://thyroxeia-deploy-production.up.railway.app" style="display:inline-block; background:linear-gradient(135deg,#7c3aed,#a855f7); color:#fff; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:700;">
        🚀 Start Studying
      </a>
    </div>
    ${FOOTER}
  </div>`
}

function eliteWelcomeTemplate(firstName) {
  return `<div style="${BASE_STYLE}">
    ${HEADER}
    <div style="background:linear-gradient(135deg,#1a1a00,#2d1e00); padding:40px 32px;">
      <h2 style="color:#f59e0b; margin:0 0 16px;">👑 Welcome to Elite!</h2>
      <p style="color:#fde68a; margin:0 0 16px;">Hi ${firstName || 'there'}! You are now an Elite member — the highest tier.</p>
      <ul style="color:#fde68a; margin:0 0 24px; padding-left:20px; line-height:2.2;">
        <li>✅ Unlimited AI calls</li>
        <li>✅ Cram Mode &amp; Exam Predictions</li>
        <li>✅ Advanced Analytics</li>
        <li>✅ Gold ⭐ username</li>
        <li>✅ Community shoutout</li>
        <li>✅ Priority support</li>
      </ul>
      <a href="https://thyroxeia-deploy-production.up.railway.app" style="display:inline-block; background:linear-gradient(135deg,#b45309,#f59e0b); color:#1a1a00; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:900;">
        👑 Open Thyroxeia
      </a>
    </div>
    ${FOOTER}
  </div>`
}

// ── POST /auth ────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { action, payload } = req.body || {}
  if (!action || !payload) return res.status(400).json({ error: 'Missing action or payload' })

  try {

    // ── send-verification ──────────────────────────────────────────────────
    if (action === 'send-verification') {
      const { email, firstName, otp } = payload
      if (!email) return res.status(400).json({ error: 'Missing email' })
      await sendEmail({
        to:      email,
        subject: '✅ Verify your Thyroxeia AI account',
        html:    verifyTemplate(firstName, otp || '(see Supabase email)'),
      })
      return res.json({ success: true })
    }

    // ── send-welcome ────────────────────────────────────────────────────────
    if (action === 'send-welcome') {
      const { email, firstName, userId } = payload
      if (!email) return res.status(400).json({ error: 'Missing email' })

      // Ensure profile row exists
      if (sb && userId) {
        await sb.from('profiles').upsert(
          { id: userId, plan: 'free', created_at: new Date().toISOString() },
          { onConflict: 'id', ignoreDuplicates: true }
        )
      }

      await sendEmail({
        to:      email,
        subject: '🎉 Welcome to Thyroxeia AI!',
        html:    welcomeTemplate(firstName),
      })
      return res.json({ success: true })
    }

    // ── send-elite-welcome ──────────────────────────────────────────────────
    if (action === 'send-elite-welcome') {
      const { email, firstName } = payload
      if (!email) return res.status(400).json({ error: 'Missing email' })
      await sendEmail({
        to:      email,
        subject: '👑 Welcome to Thyroxeia AI Elite!',
        html:    eliteWelcomeTemplate(firstName),
      })
      return res.json({ success: true })
    }

    // ── elite-shoutout ──────────────────────────────────────────────────────
    if (action === 'elite-shoutout') {
      const { userId, displayName } = payload
      if (!userId || !displayName) return res.status(400).json({ error: 'Missing userId or displayName' })
      if (sb) {
        const { error } = await sb.from('shoutouts').insert({ user_id: userId, display_name: displayName })
        if (error) throw new Error(error.message)
      }
      return res.json({ success: true })
    }

    res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    console.error('[Auth route error]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
