/**
 * /ai  — Secure Gemini AI proxy with per-plan daily rate limiting
 *        + automatic API key rotation (tries next key on quota exhaustion)
 *
 * Plans & daily limits:
 *   free    →  5 calls/day
 *   student → 20 calls/day
 *   pro     → 50 calls/day
 *   elite   → 50 calls/day
 *
 * Requires Authorization: Bearer <supabase_jwt> header from frontend.
 *
 * Env vars for key rotation (set all you have, backend picks a working one):
 *   GEMINI_API_KEY    — primary key
 *   GEMINI_API_KEY_2  — fallback 1
 *   GEMINI_API_KEY_3  — fallback 2
 *   GEMINI_API_KEY_4  — fallback 3
 *   GEMINI_API_KEY_5  — fallback 4
 */

import { Router }     from 'express'
import { createClient } from '@supabase/supabase-js'

const router = Router()
const GEMINI_MODEL = 'gemini-2.0-flash-lite'
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models'

// Daily AI call limits per plan
const PLAN_LIMITS = { free: 5, student: 20, pro: 50, elite: 50 }

// ── Key rotation pool ─────────────────────────────────────────────────────────
// Reads up to 5 keys from env vars — skips blanks automatically
function buildKeyPool() {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].filter(k => k && k.trim().length > 0)
  if (!keys.length) throw new Error('No Gemini API keys configured in environment')
  return keys
}

// Track which keys are temporarily exhausted and when to retry them
// { keyIndex: { exhaustedAt: timestamp, retryAfter: timestamp } }
const exhaustedKeys = {}

function getAvailableKey(keys) {
  const now = Date.now()
  for (let i = 0; i < keys.length; i++) {
    const e = exhaustedKeys[i]
    if (!e || now >= e.retryAfter) return { key: keys[i], index: i }
  }
  // All keys exhausted — return the one that recovers soonest
  let soonest = 0
  for (let i = 1; i < keys.length; i++) {
    if ((exhaustedKeys[i]?.retryAfter || 0) < (exhaustedKeys[soonest]?.retryAfter || 0)) soonest = i
  }
  console.warn('[Gemini] All keys quota-exhausted, using soonest-recovery key')
  return { key: keys[soonest], index: soonest }
}

function markKeyExhausted(index) {
  // Back off for 60 minutes (Gemini quota resets hourly)
  exhaustedKeys[index] = { exhaustedAt: Date.now(), retryAfter: Date.now() + 60 * 60 * 1000 }
  console.warn(`[Gemini] Key #${index + 1} marked exhausted — will retry after 60 min`)
}

// ── Gemini call with automatic key rotation ───────────────────────────────────
async function gemini(prompt, maxTokens = 4096) {
  const { default: fetch } = await import('node-fetch')
  const keys = buildKeyPool()
  let lastError = null

  // Try each available key in order
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const { key, index } = getAvailableKey(keys)

    const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${key}`
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens }
        })
      })

      if (resp.status === 429 || resp.status === 503) {
        // Quota exceeded or overloaded — rotate to next key
        const body = await resp.text()
        console.warn(`[Gemini] Key #${index + 1} returned ${resp.status} — rotating`)
        markKeyExhausted(index)
        lastError = new Error(`Key #${index + 1} quota/overload (${resp.status})`)
        continue  // try next key
      }

      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(`Gemini error ${resp.status}: ${body.substring(0, 200)}`)
      }

      const data = await resp.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

      // Log which key was used (index only, not the actual key)
      if (index > 0) console.log(`[Gemini] Used key #${index + 1} (primary was exhausted)`)
      return text

    } catch (err) {
      if (err.message.includes('quota') || err.message.includes('429')) {
        markKeyExhausted(index)
        lastError = err
        continue
      }
      throw err  // non-quota errors bubble up immediately
    }
  }

  // All keys failed
  throw new Error(`All Gemini API keys exhausted. ${lastError?.message || ''}`)
}

// ── Supabase clients ──────────────────────────────────────────────────────────
const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

const sbAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

// ── Auth: verify JWT ──────────────────────────────────────────────────────────
async function getUserFromToken(req) {
  const auth  = req.headers['authorization'] || ''
  const token = auth.replace('Bearer ', '').trim()
  if (!token) return null
  const client = sbAnon || sb
  if (!client) return null
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) return null
  return data.user
}

// ── Get user plan from profiles ───────────────────────────────────────────────
async function getUserPlan(userId) {
  if (!sb) return 'free'
  const { data } = await sb.from('profiles').select('plan').eq('id', userId).single()
  return data?.plan || 'free'
}

// ── Daily usage check + increment ────────────────────────────────────────────
async function checkAndIncrementUsage(userId, plan) {
  const limit = PLAN_LIMITS[plan] || 5
  const today = new Date().toISOString().slice(0, 10)

  if (!sb) {
    console.warn('[AI] Supabase not configured — skipping usage tracking')
    return { allowed: true, used: 0, limit }
  }

  // Try stored procedure first (atomic, no race conditions)
  const { data: rpcData, error: rpcErr } = await sb.rpc('increment_ai_usage', {
    p_user_id: userId,
    p_date:    today
  })

  if (!rpcErr) {
    const newCount = rpcData ?? 1
    return { allowed: newCount <= limit, used: newCount, limit }
  }

  // Fallback: manual upsert
  const { data: existing } = await sb
    .from('ai_usage').select('count')
    .eq('user_id', userId).eq('date', today).single()

  const current = existing?.count || 0
  if (current >= limit) return { allowed: false, used: current, limit }

  if (existing) {
    await sb.from('ai_usage').update({ count: current + 1 }).eq('user_id', userId).eq('date', today)
  } else {
    await sb.from('ai_usage').insert({ user_id: userId, date: today, count: 1 })
  }
  return { allowed: true, used: current + 1, limit }
}

function parseJsonArray(text) {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('AI returned invalid format')
  return JSON.parse(m[0])
}
function parseJsonObject(text) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('AI returned invalid format')
  return JSON.parse(m[0])
}

// ── POST /ai ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { type, payload } = req.body || {}
  if (!type || !payload) return res.status(400).json({ error: 'Missing type or payload' })

  // Validate at least one key is configured
  try { buildKeyPool() } catch (e) {
    return res.status(500).json({ error: 'No Gemini API keys configured on server' })
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  const user = await getUserFromToken(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized — please log in' })

  // ── Rate limiting ───────────────────────────────────────────────────────
  const plan = await getUserPlan(user.id)
  const { allowed, used, limit } = await checkAndIncrementUsage(user.id, plan)

  if (!allowed) {
    return res.status(429).json({
      error: `Daily AI limit reached (${limit} calls/day on the ${plan} plan). Upgrade for more!`,
      used, limit, plan
    })
  }

  res.setHeader('X-AI-Used',  used)
  res.setHeader('X-AI-Limit', limit)

  try {
    switch (type) {

      // ── Generate flashcards ─────────────────────────────────────────────
      case 'generate-cards': {
        const { text, count = 15 } = payload
        if (!text) return res.status(400).json({ error: 'Missing text' })
        const raw = await gemini(
          `Generate exactly ${count} high-quality flashcards from the content below.\n` +
          `Return ONLY a JSON array (no markdown, no explanation):\n` +
          `[{"q":"Question?","a":"Clear concise answer."}]\n\nContent:\n${String(text).substring(0, 8000)}`,
          4096
        )
        return res.json({ cards: parseJsonArray(raw), used, limit })
      }

      // ── Generate quiz ───────────────────────────────────────────────────
      case 'generate-quiz': {
        const { cards, count = 10 } = payload
        if (!Array.isArray(cards) || !cards.length) return res.status(400).json({ error: 'Missing cards' })
        const cardDump = cards.slice(0, 25).map(c => `Q: ${c.q}\nA: ${c.a}`).join('\n---\n')
        const raw = await gemini(
          `Create ${Math.min(count, cards.length)} multiple-choice quiz questions from these flashcards.\n` +
          `Each must have 4 options and one correct answer.\n` +
          `Return ONLY a JSON array:\n[{"q":"?","correct":"answer","options":["A","B","C","D"]}]\n\n` +
          `Flashcards:\n${cardDump}`,
          4096
        )
        return res.json({ quiz: parseJsonArray(raw), used, limit })
      }

      // ── Grade typed answer ──────────────────────────────────────────────
      case 'grade-answer': {
        const { question, correctAnswer, userAnswer } = payload
        if (!question || !correctAnswer || !userAnswer) return res.status(400).json({ error: 'Missing fields' })
        const raw = await gemini(
          `Grade this student answer fairly. Accept minor spelling/wording differences.\n\n` +
          `Question: ${question}\nModel answer: ${correctAnswer}\nStudent answer: ${userAnswer}\n\n` +
          `Return ONLY JSON: {"correct":true|false,"score":1-5,"feedback":"One encouraging sentence."}`,
          300
        )
        return res.json({ ...parseJsonObject(raw), used, limit })
      }

      // ── AI Tutor chat ───────────────────────────────────────────────────
      case 'chat': {
        const { message, history = [] } = payload
        if (!message) return res.status(400).json({ error: 'Missing message' })
        const context = history.slice(-6)
          .map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n')
        const prompt =
          `You are Thyroxeia AI, a brilliant, friendly tutor. ` +
          `Be clear, encouraging, and use examples. Format with **bold** and bullet points.\n\n` +
          (context ? `Previous conversation:\n${context}\n\n` : '') +
          `Student: ${message}\nTutor:`
        const reply = await gemini(prompt, 2048)
        return res.json({ reply: reply.trim(), used, limit })
      }

      // ── Study guide ─────────────────────────────────────────────────────
      case 'study-guide': {
        const { deckName, cards } = payload
        if (!Array.isArray(cards) || !cards.length) return res.status(400).json({ error: 'Missing cards' })
        const cardList = cards.slice(0, 25).map((c, i) => `${i + 1}. Q: ${c.q}  A: ${c.a}`).join('\n')
        const guide = await gemini(
          `Write a comprehensive study guide for: "${deckName}"\n\nBased on:\n${cardList}\n\n` +
          `Structure with ## Overview, ## Key Concepts, ## Exam Tips, ## Quick Review.\n` +
          `Use **bold** for key terms. Be thorough but under 600 words.`,
          2048
        )
        return res.json({ guide: guide.trim(), used, limit })
      }

      default:
        return res.status(400).json({ error: `Unknown AI type: ${type}` })
    }
  } catch (err) {
    console.error('[AI route error]', err.message)

    // If all keys are exhausted, give a friendlier message
    if (err.message.includes('exhausted') || err.message.includes('quota')) {
      return res.status(503).json({
        error: 'AI is temporarily busy — all keys at capacity. Please try again in a few minutes.',
        retryAfter: 60
      })
    }
    res.status(500).json({ error: err.message })
  }
})

// ── GET /ai/status — shows key pool health (admin only, requires secret header) ──
router.get('/status', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET || 'thyroxeia-admin'
  if (req.headers['x-admin-secret'] !== adminSecret) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  let pool
  try { pool = buildKeyPool() } catch { return res.json({ keys: 0, status: 'no keys configured' }) }

  const now = Date.now()
  const keyStatus = pool.map((_, i) => {
    const e = exhaustedKeys[i]
    if (!e || now >= e.retryAfter) return { index: i + 1, status: 'available' }
    return { index: i + 1, status: 'exhausted', recoversIn: Math.round((e.retryAfter - now) / 60000) + 'min' }
  })
  res.json({ totalKeys: pool.length, keys: keyStatus })
})

export default router
