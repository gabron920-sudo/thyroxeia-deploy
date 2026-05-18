import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

const PLAN_LIMITS = { free: 8, student: 20, pro: 40, elite: 60 }
const FEATURE_ACCESS = {
  'generate-cards': ['free','student','pro','elite'],
  'generate-quiz': ['student','pro','elite'],
  'timed-quiz': ['free','student','pro','elite'],
  'grade-answer': ['free','student','pro','elite'],
  'chat': ['student','pro','elite'],
  'study-guide': ['student','pro','elite'],
}

function canUseFeature(plan, type) {
  const allowed = FEATURE_ACCESS[type]
  return !allowed || allowed.includes(plan || 'free')
}

function getGeminiKeys(env) {
  return [1,2,3,4,5,6,7,8,9,10,11,12,13]
    .map(i => env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    .filter(Boolean)
}

function jsonError(c, message, status = 500, extra = {}) {
  return c.json({ error: message, ...extra }, status)
}

app.post('/', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return jsonError(c, 'Authentication required. Please log in.', 401)

  const sb = (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY)
    ? createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
    : null
  if (!sb) return jsonError(c, 'AI service auth is not configured.', 500)

  const { data: { user }, error: userErr } = await sb.auth.getUser(token)
  if (userErr || !user) return jsonError(c, 'Invalid or expired session. Please log in again.', 401)

  let body
  try { body = await c.req.json() } catch { return jsonError(c, 'Invalid JSON body.', 400) }

  const type = body?.type
  const payload = body?.payload || {}

  const { data: profile } = await sb.from('profiles').select('plan').eq('id', user.id).maybeSingle()
  const userPlan = profile?.plan || 'free'

  if (type && !canUseFeature(userPlan, type)) {
    return jsonError(c, `${type} is not available on the ${userPlan} plan. Upgrade to unlock this feature.`, 403, { plan: userPlan })
  }

  const today = new Date().toISOString().slice(0, 10)
  const dailyLimit = PLAN_LIMITS[userPlan] ?? PLAN_LIMITS.free
  let usedToday = 0

  const { count } = await sb.from('ai_usage')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', `${today}T00:00:00.000Z`)
  usedToday = count || 0

  if (dailyLimit < 9999 && usedToday >= dailyLimit) {
    return jsonError(c, `Daily limit reached (${dailyLimit} calls/day on ${userPlan} plan). Upgrade for more AI calls.`, 429, {
      limit: dailyLimit,
      used: usedToday,
      plan: userPlan
    })
  }

  // Free users get 2 conversion/generation calls per day. This uses existing ai_usage count for safety.
  if (userPlan === 'free' && type === 'generate-cards' && usedToday >= 2) {
    return jsonError(c, 'Free plan includes 2 AI conversions per day for notes, PDFs, lectures, or video transcripts. Upgrade for more conversions.', 429, {
      plan: userPlan,
      freeConversionLimit: 2,
      used: usedToday
    })
  }

  let prompt = body.prompt
  let history = body.history || payload.history || []

  if (!prompt && type && payload) {
    if (type === 'generate-cards') {
      const cardCount = payload.count || 10
      prompt = `You are a study material generator. Convert the following notes, text PDF content, lecture notes, video transcript/captions, or topic into a complete study pack.
Generate exactly ${cardCount} flashcards, plus a concise concept overview, key terms, practice questions, and a study guide.
Return ONLY valid JSON in this exact format, no markdown, no extra text:
{"overview":"short general concept overview","keyTerms":[{"term":"term","definition":"definition"}],"cards":[{"q":"question","a":"answer"}],"practiceQuestions":[{"q":"question","a":"answer"}],"studyGuide":"concise study guide with memory tips"}

Source material:
${payload.text}`
    } else if (type === 'generate-quiz') {
      const cards = (payload.cards || []).map(card => `Q: ${card.q} | A: ${card.a}`).join('\n')
      const count = payload.count || 5
      prompt = `Generate exactly ${count} multiple-choice quiz questions based on these flashcards.
Return ONLY valid JSON:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"}]}

Flashcards:
${cards}`
    } else if (type === 'timed-quiz') {
      const cards = (payload.cards || []).map(card => `Q: ${card.q} | A: ${card.a}`).join('\n')
      prompt = `Generate ${payload.count || 5} timed quiz questions from these flashcards. Each must have 4 options with one correct answer.
Return ONLY valid JSON:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"}]}

Flashcards:
${cards}`
    } else if (type === 'grade-answer') {
      prompt = `Grade this student's answer fairly.
Question: ${payload.question}
Correct answer: ${payload.correctAnswer}
Student answer: ${payload.userAnswer}
Return ONLY valid JSON:
{"correct":true,"score":3,"feedback":"brief feedback"}`
    } else if (type === 'chat') {
      prompt = payload.message || payload.text
      history = payload.history || []
    } else if (type === 'study-guide') {
      const cards = (payload.cards || []).map(card => `- ${card.q}: ${card.a}`).join('\n')
      prompt = `Create a concise study guide for "${payload.deckName || 'this deck'}" based on these flashcards. Include sections, key ideas, memory tips, and likely test points. Keep it practical.

${cards}`
    } else {
      prompt = payload.text || payload.message || JSON.stringify(payload)
    }
  }

  if (!prompt) return jsonError(c, 'Missing prompt.', 400)

  const geminiKeys = getGeminiKeys(c.env)
  if (!geminiKeys.length) return jsonError(c, 'No Gemini API keys configured on server.', 500)

  const requestedModel = body.model || c.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  const modelCandidates = [...new Set([requestedModel, 'gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean))]
  const contents = history?.length
    ? [...history, { role: 'user', parts: [{ text: prompt }] }]
    : [{ role: 'user', parts: [{ text: prompt }] }]

  let response, data, targetModel = modelCandidates[0], lastError = null
  const shuffledKeys = [...geminiKeys].sort(() => Math.random() - 0.5)

  outer: for (const apiKey of shuffledKeys) {
    for (const modelName of modelCandidates) {
      targetModel = modelName
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2048 } })
      })
      data = await response.json().catch(() => ({}))
      if (response.ok) break outer
      lastError = data?.error?.message || `AI generation failed with ${modelName}`
      const retryable = response.status === 404 || response.status === 429 || /not found|not supported|quota|rate limit|exceeded/i.test(lastError)
      if (!retryable) break outer
      console.warn(`[AI] Gemini attempt failed (${modelName}); trying fallback if available:`, lastError)
    }
  }

  if (!response?.ok) {
    return jsonError(c, 'AI quota/model error. All configured Gemini keys/models failed. Check Google AI Studio billing/quota or add fresh keys.', response?.status || 500, {
      detail: lastError || data?.error?.message || 'AI generation failed',
      plan: userPlan
    })
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.'

  // Nonfatal logging: never break AI output if usage logging table/policy has an issue.
  const { error: usageErr } = await sb.from('ai_usage').insert({
    user_id: user.id,
    model: targetModel,
    created_at: new Date().toISOString()
  })
  if (usageErr) console.warn('[AI Usage Log Error]', usageErr.message)

  const remaining = Math.max(0, dailyLimit - usedToday - 1)
  const base = { text, remaining, used: usedToday + 1, limit: dailyLimit, plan: userPlan }

  if (type && ['generate-cards', 'generate-quiz', 'timed-quiz', 'grade-answer'].includes(type)) {
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned)
      return c.json({ ...parsed, ...base })
    } catch (parseErr) {
      console.error('[AI Parse Error]', parseErr.message, text.slice(0, 200))
    }
  }

  if (type === 'chat') return c.json({ ...base, reply: text })
  if (type === 'study-guide') return c.json({ ...base, guide: text })
  return c.json(base)
})

export default app
