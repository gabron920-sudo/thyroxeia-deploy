import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { reconcileIfStale } from './payment.js'

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

// Only these model IDs may ever be requested. The client cannot pick an
// arbitrary Gemini model, and the fallback order below is fixed server-side.
const ALLOWED_MODELS = new Set([
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-flash-latest',
])
const FALLBACK_MODELS = ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest']

// Every hard input cap. The Zod schemas below enforce these, so there is exactly
// one source of truth for "how much input is allowed".
const LIMITS = {
  cards:                60,
  cardFieldChars:       1200,
  quizCount:            20,
  cardCount:            30,
  questionChars:        2000,
  answerChars:          2000,
  deckNameChars:        120,
  sourceTextChars:      30000,
  chatMessageChars:     4000,
  historyMessages:      12,
  historyMessageChars:  4000,
  historyTotalChars:    24000,
  maxOutputTokens:      2048,
  maxBodyBytes:         262144, // 256 KB — nothing legitimate comes close
}

function canUseFeature(plan, type) {
  const allowed = FEATURE_ACCESS[type]
  return Boolean(allowed) && allowed.includes(plan || 'free')
}

function getGeminiKeys(env) {
  return [1,2,3,4,5,6,7,8,9,10,11,12,13]
    .map(i => env[`GEMINI_API_KEY${i > 1 ? '_' + i : ''}`])
    .filter(Boolean)
}

function jsonError(c, message, status = 500, extra = {}) {
  return c.json({ error: message, ...extra }, status)
}

// ── Request schemas (Zod) ──────────────────────────────────────────────────────
// Unknown keys are stripped, wrong types are rejected, and every string/array is
// length-capped, so nothing unbounded can reach the model or the prompt builder.

const cardSchema = z.object({
  q:        z.string().max(LIMITS.cardFieldChars).optional(),
  a:        z.string().max(LIMITS.cardFieldChars).optional(),
  question: z.string().max(LIMITS.cardFieldChars).optional(),
  answer:   z.string().max(LIMITS.cardFieldChars).optional(),
}).transform(card => ({
  q: (card.q ?? card.question ?? '').trim(),
  a: (card.a ?? card.answer ?? '').trim(),
}))

const cardsSchema = z.array(cardSchema)
  .max(LIMITS.cards, { message: `A deck may contain at most ${LIMITS.cards} cards per AI request.` })
  .transform(cards => cards.filter(card => card.q && card.a))
  .refine(cards => cards.length > 0, { message: 'At least one card with a question and answer is required.' })

const historySchema = z.array(z.object({
  role:  z.string().max(32),
  parts: z.array(z.object({ text: z.string().max(32000) })).max(8).optional(),
}))
  .max(200)
  .transform(turns => {
    // Only user/model turns survive; everything is flattened to plain text parts.
    const cleaned = []
    let total = 0
    for (const turn of turns) {
      const role = turn.role === 'model' ? 'model' : turn.role === 'user' ? 'user' : null
      if (!role) continue
      const text = (turn.parts || []).map(part => part.text || '').join('').slice(0, LIMITS.historyMessageChars)
      if (!text) continue
      total += text.length
      if (total > LIMITS.historyTotalChars) break
      cleaned.push({ role, parts: [{ text }] })
    }
    return cleaned
  })

// Counts are clamped, not rejected: the UI may ask for more cards than one AI
// call should produce, and clamping keeps the request working instead of failing.
const countSchema = (max, fallback) => z.any().optional().transform(value => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(max, Math.trunc(n))
})

const PAYLOAD_SCHEMAS = {
  'generate-cards': z.object({
    text:  z.string().trim().min(1).max(LIMITS.sourceTextChars, {
      message: `Source material is too long (max ${LIMITS.sourceTextChars.toLocaleString()} characters).`,
    }),
    count: countSchema(LIMITS.cardCount, 10),
  }),
  'generate-quiz': z.object({
    cards: cardsSchema,
    count: countSchema(LIMITS.quizCount, 5),
  }),
  'timed-quiz': z.object({
    cards: cardsSchema,
    count: countSchema(LIMITS.quizCount, 5),
  }),
  'grade-answer': z.object({
    question:      z.string().trim().min(1).max(LIMITS.questionChars),
    correctAnswer: z.string().trim().min(1).max(LIMITS.answerChars),
    userAnswer:    z.string().trim().min(1).max(LIMITS.answerChars),
  }),
  'chat': z.object({
    message: z.string().trim().min(1).max(LIMITS.chatMessageChars, {
      message: `Message is too long (max ${LIMITS.chatMessageChars.toLocaleString()} characters).`,
    }),
    history: historySchema.optional(),
  }),
  'study-guide': z.object({
    deckName: z.string().max(500).optional(),
    cards:    cardsSchema,
  }),
}

const bodySchema = z.object({
  type:    z.enum(Object.keys(FEATURE_ACCESS), { message: 'Unknown or missing request type.' }),
  model:   z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

// Validate a request's payload for a given feature. Returns a clean error string
// instead of throwing so the route can answer with a 400.
function validateRequest(type, payload) {
  const schema = PAYLOAD_SCHEMAS[type]
  if (!schema) return { ok: false, error: 'Unknown or missing request type.' }

  const parsed = schema.safeParse(payload ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
    return { ok: false, error: `Invalid input — ${where}${issue?.message || 'invalid value'}` }
  }
  return { ok: true, data: parsed.data }
}

// Build the prompt server-side from already-validated input. The client can never
// supply a raw prompt, so feature gating cannot be bypassed.
function buildPrompt(type, data) {
  switch (type) {
    case 'generate-cards': {
      return `You are a study material generator. Convert the following notes, text PDF content, lecture notes, video transcript/captions, or topic into a complete study pack.
Generate exactly ${data.count} flashcards, plus a concise concept overview, key terms, practice questions, and a study guide.
Return ONLY valid JSON in this exact format, no markdown, no extra text:
{"overview":"short general concept overview","keyTerms":[{"term":"term","definition":"definition"}],"cards":[{"q":"question","a":"answer"}],"practiceQuestions":[{"q":"question","a":"answer"}],"studyGuide":"concise study guide with memory tips"}

Source material:
${data.text}`
    }
    case 'generate-quiz': {
      const list = data.cards.map(card => `Q: ${card.q} | A: ${card.a}`).join('\n')
      return `Generate exactly ${data.count} multiple-choice quiz questions based on these flashcards.
Return ONLY valid JSON:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"}]}

Flashcards:
${list}`
    }
    case 'timed-quiz': {
      const list = data.cards.map(card => `Q: ${card.q} | A: ${card.a}`).join('\n')
      return `Generate ${data.count} timed quiz questions from these flashcards. Each must have 4 options with one correct answer.
Return ONLY valid JSON:
{"questions":[{"q":"question","options":["A","B","C","D"],"answer":"correct option text"}]}

Flashcards:
${list}`
    }
    case 'grade-answer': {
      return `Grade this student's answer fairly.
Question: ${data.question}
Correct answer: ${data.correctAnswer}
Student answer: ${data.userAnswer}
Return ONLY valid JSON:
{"correct":true,"score":3,"feedback":"brief feedback"}`
    }
    case 'chat':
      return data.message
    case 'study-guide': {
      const deckName = (data.deckName || '').slice(0, LIMITS.deckNameChars) || 'this deck'
      const list = data.cards.map(card => `- ${card.q}: ${card.a}`).join('\n')
      return `Create a concise study guide for "${deckName}" based on these flashcards. Include sections, key ideas, memory tips, and likely test points. Keep it practical.

${list}`
    }
    default:
      return null
  }
}

// Durable rate limiting via Cloudflare's Rate Limiting binding.
// Falls back to the per-isolate throttle in the Worker when the binding is absent.
async function withinRateLimit(c, bucketKey) {
  const limiter = c.env.AI_RATE_LIMITER
  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key: bucketKey })
      return success !== false
    } catch (e) {
      console.warn('[AI] Rate limiting binding error:', e?.message || e)
    }
  }
  return true
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

  if (!(await withinRateLimit(c, `ai:${user.id}`))) {
    return jsonError(c, 'Too many AI requests. Please slow down and try again shortly.', 429)
  }

  const declaredBytes = Number(c.req.header('content-length') || 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > LIMITS.maxBodyBytes) {
    return jsonError(c, 'Request body is too large.', 413)
  }

  let rawBody
  try { rawBody = await c.req.json() } catch { return jsonError(c, 'Invalid JSON body.', 400) }

  const bodyResult = bodySchema.safeParse(rawBody)
  if (!bodyResult.success) {
    const issue = bodyResult.error.issues[0]
    return jsonError(c, `Invalid request — ${issue?.message || 'malformed body'}`, 400)
  }
  const body = bodyResult.data
  const type = body.type

  // An unapproved model is a rejected request, not a silent downgrade.
  if (body.model && !ALLOWED_MODELS.has(body.model)) {
    return jsonError(c, 'That AI model is not available.', 400)
  }

  const validation = validateRequest(type, body.payload ?? {})
  if (!validation.ok) return jsonError(c, validation.error, 400)
  const data = validation.data

  const { data: profile } = await sb.from('profiles')
    .select('plan, current_period_end, paypal_subscription_id')
    .eq('id', user.id)
    .maybeSingle()

  // A paid plan whose billing period has ended is re-checked with PayPal here, so
  // a non-paying or cancelled subscriber loses access without waiting for a webhook
  // or for them to open the app.
  const { plan: freshPlan } = await reconcileIfStale(sb, c.env, user.id, profile)
  const userPlan = freshPlan || 'free'

  if (!canUseFeature(userPlan, type)) {
    return jsonError(c, `${type} is not available on the ${userPlan} plan. Upgrade to unlock this feature.`, 403, { plan: userPlan })
  }

  const today = new Date().toISOString().slice(0, 10)
  const dailyLimit = PLAN_LIMITS[userPlan] ?? PLAN_LIMITS.free

  const { count } = await sb.from('ai_usage')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', `${today}T00:00:00.000Z`)
  const usedToday = count || 0

  if (usedToday >= dailyLimit) {
    return jsonError(c, `Daily limit reached (${dailyLimit} calls/day on ${userPlan} plan). Upgrade for more AI calls.`, 429, {
      limit: dailyLimit,
      used: usedToday,
      plan: userPlan
    })
  }

  // Free users get 2 conversion/generation calls per day.
  if (userPlan === 'free' && type === 'generate-cards' && usedToday >= 2) {
    return jsonError(c, 'Free plan includes 2 AI conversions per day for notes, PDFs, lectures, or video transcripts. Upgrade for more conversions.', 429, {
      plan: userPlan,
      freeConversionLimit: 2,
      used: usedToday
    })
  }

  const prompt = buildPrompt(type, data)
  if (!prompt) return jsonError(c, 'Missing or invalid input for this request type.', 400)

  const history = type === 'chat' ? (data.history || []) : []

  const geminiKeys = getGeminiKeys(c.env)
  if (!geminiKeys.length) return jsonError(c, 'No Gemini API keys configured on server.', 500)

  const requestedModel = body.model && ALLOWED_MODELS.has(body.model) ? body.model : null
  const defaultModel = ALLOWED_MODELS.has(c.env.GEMINI_MODEL) ? c.env.GEMINI_MODEL : FALLBACK_MODELS[0]
  const modelCandidates = [...new Set([requestedModel, defaultModel, ...FALLBACK_MODELS].filter(Boolean))]

  const contents = history.length
    ? [...history, { role: 'user', parts: [{ text: prompt }] }]
    : [{ role: 'user', parts: [{ text: prompt }] }]

  let response, aiJson, targetModel = modelCandidates[0], lastError = null
  const shuffledKeys = [...geminiKeys].sort(() => Math.random() - 0.5)

  outer: for (const apiKey of shuffledKeys) {
    for (const modelName of modelCandidates) {
      targetModel = modelName
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: LIMITS.maxOutputTokens } })
      })
      aiJson = await response.json().catch(() => ({}))
      if (response.ok) break outer
      lastError = aiJson?.error?.message || `AI generation failed with ${modelName}`
      const retryable = response.status === 404 || response.status === 429 || /not found|not supported|quota|rate limit|exceeded/i.test(lastError)
      if (!retryable) break outer
      console.warn(`[AI] Gemini attempt failed (${modelName}); trying fallback if available:`, lastError)
    }
  }

  if (!response?.ok) {
    return jsonError(c, 'AI quota/model error. All configured Gemini keys/models failed. Check Google AI Studio billing/quota or add fresh keys.', response?.status || 500, {
      detail: lastError || aiJson?.error?.message || 'AI generation failed',
      plan: userPlan
    })
  }

  const text = aiJson?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.'

  // Nonfatal logging: never break AI output if usage logging table/policy has an issue.
  const { error: usageErr } = await sb.from('ai_usage').insert({
    user_id: user.id,
    model: targetModel,
    created_at: new Date().toISOString()
  })
  if (usageErr) console.warn('[AI Usage Log Error]', usageErr.message)

  const remaining = Math.max(0, dailyLimit - usedToday - 1)
  const base = { text, remaining, used: usedToday + 1, limit: dailyLimit, plan: userPlan }

  if (['generate-cards', 'generate-quiz', 'timed-quiz', 'grade-answer'].includes(type)) {
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

// Exported for tests — these are the pure validation helpers.
export { buildPrompt, validateRequest, bodySchema, LIMITS, ALLOWED_MODELS }
