/**
 * /ai — Gemini proxy with key rotation, JWT auth, and plan-based quotas
 *
 * POST /ai
 * Headers: Authorization: Bearer <supabase_jwt>
 * Body: { prompt, model?, history? }
 */
import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'

const router = Router()

// ── Gemini key pool (round-robin across all 5 configured keys) ────────────────
const GEMINI_KEYS = [1,2,3,4,5]
  .map(i => process.env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
  .filter(Boolean)
let _keyIdx = 0
function nextKey() {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini API keys configured on server')
  const key = GEMINI_KEYS[_keyIdx % GEMINI_KEYS.length]
  _keyIdx++
  return key
}

// ── Supabase (auth + quota tracking) ─────────────────────────────────────────
const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── Daily AI call limits per plan ─────────────────────────────────────────────
const PLAN_LIMITS = { free: 5, student: 20, pro: 50, elite: 50 }

// ── POST /ai ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {

  // ── 1. Verify Supabase JWT ─────────────────────────────────────────────────
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required. Please log in.' })

  let userId = null
  let userPlan = 'free'

  if (sb) {
    const { data: { user }, error } = await sb.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })
    userId = user.id

    // Get user's plan from profiles table
    const { data: profile } = await sb.from('profiles').select('plan').eq('id', userId).single()
    userPlan = profile?.plan || 'free'
  }

  // ── 2. Daily quota check ───────────────────────────────────────────────────
  const dailyLimit = PLAN_LIMITS[userPlan] ?? PLAN_LIMITS.free
  let usedToday = 0

  if (sb && userId) {
    const today = new Date().toISOString().split('T')[0]
    const { count } = await sb.from('ai_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', `${today}T00:00:00.000Z`)
    usedToday = count || 0

    if (usedToday >= dailyLimit) {
      return res.status(429).json({
        error: `Daily limit reached (${dailyLimit} calls/day on ${userPlan} plan). Upgrade to get more AI calls.`,
        limit: dailyLimit,
        used: usedToday,
        plan: userPlan
      })
    }
  }

  // ── 3. Validate request body ───────────────────────────────────────────────
  const { prompt, model, history } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

  try {
    const { default: fetch } = await import('node-fetch')
    const API_KEY = nextKey()
    const targetModel = model || 'gemini-1.5-flash'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${API_KEY}`

    const contents = history
      ? [...history, { role: 'user', parts: [{ text: prompt }] }]
      : [{ role: 'user', parts: [{ text: prompt }] }]

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2048 } })
    })

    const data = await response.json()
    if (!response.ok) {
      console.error('[AI Error]', data)
      return res.status(response.status).json({ error: data.error?.message || 'AI generation failed' })
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.'

    // ── 4. Log usage to Supabase ───────────────────────────────────────────
    if (sb && userId) {
      await sb.from('ai_usage').insert({
        user_id: userId,
        model: targetModel,
        created_at: new Date().toISOString()
      })
    }

    const remaining = dailyLimit - usedToday - 1
    console.log(`[AI] ✅ ${userPlan} user ${userId} — ${remaining} calls remaining today`)
    return res.json({ text, remaining, limit: dailyLimit, plan: userPlan })

  } catch (err) {
    console.error('[AI Exception]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
