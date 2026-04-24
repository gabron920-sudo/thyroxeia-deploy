/**
 * /ai — Gemini-powered study tools
 *
 * SECURITY:
 *  - Requires valid Supabase JWT (Bearer token)
 *  - Rate-limits by plan: free=5, student=30, pro=unlimited, elite=unlimited
 *  - Rotates across multiple GEMINI_API_KEY_* env vars
 *  - Backend never exposes Gemini keys to browser
 */

import { Router }       from 'express'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const router = Router()

// ── Supabase (service key for server-side operations) ───────────────────────
const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

// ── Gemini key rotation ──────────────────────────────────────────────────────
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

let keyIndex = 0
function getModel() {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini API keys configured')
  const key = GEMINI_KEYS[keyIndex % GEMINI_KEYS.length]
  keyIndex++
  const genAI = new GoogleGenerativeAI(key)
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
}

// ── Plan limits ───────────────────────────────────────────────────────────────
const PLAN_LIMITS = { free: 5, student: 30, pro: 999999, elite: 999999 }

// ── In-memory rate limit store (resets on restart — use Redis for prod) ──────
const rateLimitStore = new Map()   // userId -> { date: 'YYYY-MM-DD', used: number }

function getRateLimit(userId, plan) {
  const today = new Date().toISOString().slice(0, 10)
  const entry = rateLimitStore.get(userId) || { date: today, used: 0 }
  if (entry.date !== today) { entry.date = today; entry.used = 0 }   // new day
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
  return { used: entry.used, limit }
}

function incrementRateLimit(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const entry = rateLimitStore.get(userId) || { date: today, used: 0 }
  if (entry.date !== today) { entry.date = today; entry.used = 0 }
  entry.used++
  rateLimitStore.set(userId, entry)
  return entry.used
}

// ── Auth middleware ──────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token      = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return res.status(401).json({ error: 'No token provided. Please log in.' })

  if (!sb) return res.status(500).json({ error: 'Supabase not configured on server' })

  try {
    const { data: { user }, error } = await sb.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })
    req.user = user
    next()
  } catch (err) {
    res.status(401).json({ error: 'Auth check failed: ' + err.message })
  }
}

// ── Plan lookup ───────────────────────────────────────────────────────────────
async function getUserPlan(userId) {
  if (!sb) return 'free'
  try {
    const { data } = await sb.from('profiles').select('plan').eq('id', userId).single()
    return data?.plan || 'free'
  } catch { return 'free' }
}

// ── POST /ai ─────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  // Frontend sends { type, payload } — we support both `type` and `action`
  const type    = req.body.type    || req.body.action
  const payload = req.body.payload || req.body
  if (!type) return res.status(400).json({ error: 'Missing type or payload' })

  const userId = req.user.id
  const plan   = await getUserPlan(userId)
  const { used, limit } = getRateLimit(userId, plan)

  // Rate limit check
  if (used >= limit) {
    return res.status(429).json({
      error: `Daily AI limit reached (${used}/${limit}). Upgrade your plan for more calls.`,
      used, limit
    })
  }

  try {
    const model = getModel()
    let result

    // ── generate-cards ────────────────────────────────────────────────────────
    if (type === 'generate-cards') {
      const { text, count = 10 } = payload
      if (!text) return res.status(400).json({ error: 'Missing text in payload' })
      const n = Math.min(parseInt(count) || 10, 30)
      const prompt = `Create exactly ${n} study flashcards from this content:\n\n${text.substring(0, 8000)}\n\nReturn ONLY valid JSON array: [{"q":"question","a":"answer"}]`
      const r = await model.generateContent(prompt)
      const raw = r.response.text().replace(/```json|```/g, '').trim()
      const cards = JSON.parse(raw)
      const newUsed = incrementRateLimit(userId)
      return res.json({ cards, used: newUsed, limit })
    }

    // ── generate-quiz ─────────────────────────────────────────────────────────
    if (type === 'generate-quiz') {
      const { cards, count = 10 } = payload
      if (!cards?.length) return res.status(400).json({ error: 'Missing cards in payload' })
      const n = Math.min(parseInt(count) || 10, 20)
      const prompt = `Create ${n} multiple-choice quiz questions from these flashcards:\n${JSON.stringify(cards.slice(0, 30))}\n\nReturn ONLY valid JSON: [{"q":"question","correct":"correct answer","options":["a","b","c","d"]}]`
      const r = await model.generateContent(prompt)
      const raw = r.response.text().replace(/```json|```/g, '').trim()
      const quiz = JSON.parse(raw)
      const newUsed = incrementRateLimit(userId)
      return res.json({ quiz, used: newUsed, limit })
    }

    // ── chat (AI tutor) ───────────────────────────────────────────────────────
    if (type === 'chat') {
      const { message } = payload
      if (!message) return res.status(400).json({ error: 'Missing message in payload' })
      const prompt = `You are Thyroxeia AI, a friendly and expert study tutor. Answer helpfully and concisely:\n\n${message.substring(0, 2000)}`
      const r = await model.generateContent(prompt)
      const newUsed = incrementRateLimit(userId)
      return res.json({ reply: r.response.text(), used: newUsed, limit })
    }

    // ── study-guide ───────────────────────────────────────────────────────────
    if (type === 'study-guide') {
      const { deckName, cards } = payload
      if (!cards?.length) return res.status(400).json({ error: 'Missing cards in payload' })
      const prompt = `Write a detailed, well-structured study guide for the topic "${deckName || 'Study Guide'}" based on these flashcards:\n\n${JSON.stringify(cards.slice(0, 50))}\n\nInclude: overview, key concepts, tips, and a summary.`
      const r = await model.generateContent(prompt)
      const newUsed = incrementRateLimit(userId)
      return res.json({ guide: r.response.text(), used: newUsed, limit })
    }

    // ── grade-answer ──────────────────────────────────────────────────────────
    if (type === 'grade-answer') {
      const { question, correctAnswer, userAnswer } = payload
      if (!question || !correctAnswer || !userAnswer) return res.status(400).json({ error: 'Missing question/correctAnswer/userAnswer' })
      const prompt = `Grade this student answer:\nQuestion: ${question}\nCorrect Answer: ${correctAnswer}\nStudent Answer: ${userAnswer}\n\nReturn ONLY valid JSON: {"correct": true/false, "feedback": "brief feedback", "score": 1-10}`
      const r = await model.generateContent(prompt)
      const raw = r.response.text().replace(/```json|```/g, '').trim()
      const grade = JSON.parse(raw)
      const newUsed = incrementRateLimit(userId)
      return res.json({ ...grade, used: newUsed, limit })
    }

    res.status(400).json({ error: 'Unknown AI type: ' + type })

  } catch (err) {
    console.error('[AI route error]', err.message)
    // If it's a JSON parse error, give a helpful message
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' })
    }
    res.status(500).json({ error: err.message })
  }
})

export default router
