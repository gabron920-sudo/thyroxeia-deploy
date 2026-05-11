
/**
 * /ai — Gemini proxy with key rotation, JWT auth, and plan-based quotas
 *
 * POST /ai
 * Headers: Authorization: Bearer <supabase_jwt>
 * Body: { prompt, model?, history? }
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

// ── Gemini key pool (random selection — CF Workers is stateless) ──────────────
function getGeminiKeys(env) {
  return [1,2,3,4,5,6,7,8,9,10,11,12,13]
    .map(i => env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    .filter(Boolean)
}
function nextKey(env) {
  const keys = getGeminiKeys(env)
  if (!keys.length) throw new Error('No Gemini API keys configured on server')
  return keys[Math.floor(Math.random() * keys.length)]
}

// ── Daily AI call limits per plan ─────────────────────────────────────────────
const PLAN_LIMITS = { free: 25, student: 60, pro: 150, elite: 300 }

// ── POST /ai ──────────────────────────────────────────────────────────────────
app.post('/', async (c) => {

  // ── 1. Verify Supabase JWT ─────────────────────────────────────────────────
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return c.json({ error: 'Authentication required. Please log in.' }, 401)

  const sb = (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY)
    ? createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
    : null

  let userId = null
  let userPlan = 'free'

  if (sb) {
    const { data: { user }, error } = await sb.auth.getUser(token)
    if (error || !user) return c.json({ error: 'Invalid or expired session. Please log in again.' }, 401)
    userId = user.id

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

    if (dailyLimit < 9999 && usedToday >= dailyLimit) {
      return c.json({
        error: `Daily limit reached (${dailyLimit} calls/day on ${userPlan} plan). Upgrade to get more AI calls.`,
        limit: dailyLimit,
        used: usedToday,
        plan: userPlan
      }, 429)
    }
  }

  // ── 3. Validate request body ───────────────────────────────────────────────
  const body = await c.req.json()
  let { prompt, model, history } = body

  // ── Build prompt from type+payload if frontend sends structured call ────────
  if (!prompt && body.type && body.payload) {
    const { type, payload } = body
    if (type === 'generate-cards') {
      const count = payload.count || 10
      prompt = `You are a flashcard generator. Based on the following text or topic, generate exactly ${count} flashcards.
Return ONLY valid JSON in this exact format, no markdown, no extra text:
{"cards":[{"q":"question","a":"answer"},...]}

Text/Topic:
${payload.text}`
    } else if (type === 'generate-quiz') {
      const cards = (payload.cards || []).map(c => `Q: ${c.q} | A: ${c.a}`).join('\n')
      const count = payload.count || 5
      prompt = `You are a quiz generator. Generate exactly ${count} multiple-choice quiz questions based on these flashcards.
Return ONLY valid JSON, no markdown:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"},...]}

Flashcards:
${cards}`
    } else if (type === 'grade-answer') {
      prompt = `You are a strict but fair teacher grading a student's answer.
Question: ${payload.question}
Correct answer: ${payload.correctAnswer}
Student's answer: ${payload.userAnswer}

Reply ONLY with valid JSON, no markdown:
{"correct":true or false,"feedback":"brief encouraging feedback in 1-2 sentences"}`
    } else if (type === 'chat') {
      prompt = payload.message
      history = payload.history || []
    } else if (type === 'study-guide') {
      const cards = (payload.cards || []).map(c => `- ${c.q}: ${c.a}`).join('\n')
      prompt = `Create a concise study guide for the topic "${payload.deckName}" based on these flashcards:
${cards}

Format it with clear sections, key concepts, and memory tips. Keep it under 400 words.`
    } else if (type === 'timed-quiz') {
      const cards = (payload.cards || []).map(c => `Q: ${c.q} | A: ${c.a}`).join('\n')
      prompt = `Generate ${payload.count || 5} timed quiz questions from these flashcards. Each must have 4 options with one correct answer.
Return ONLY valid JSON:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"},...]}

Flashcards:
${cards}`
    } else {
      prompt = payload.text || payload.message || JSON.stringify(payload)
    }
  }

  if (!prompt) return c.json({ error: 'Missing prompt' }, 400)

  try {
    const API_KEY = nextKey(c.env)
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
      return c.json({ error: data.error?.message || 'AI generation failed' }, response.status)
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

    // ── 5. Parse structured JSON responses for typed calls ─────────────────
    const type = body?.type
    if (type && ['generate-cards','generate-quiz','grade-answer','timed-quiz'].includes(type)) {
      try {
        const cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
        const parsed = JSON.parse(cleaned)
        return c.json({ ...parsed, text, remaining, used: usedToday + 1, limit: dailyLimit, plan: userPlan })
      } catch(e) {
        console.error('[AI Parse Error]', e.message, text.slice(0, 200))
        // Return raw text so frontend can handle gracefully
      }
    }

    return c.json({ text, remaining, used: usedToday + 1, limit: dailyLimit, plan: userPlan })

  } catch (err) {
    console.error('[AI Exception]', err.message)
    return c.json({ error: 'AI request failed. Please try again.' }, 500)
  }
})

export default app
