/**
 * /ai — Gemini proxy with usage logging
 * Supports Gemini 1.5 Flash/Pro and rate limiting via Supabase
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const app = new Hono()

const FEATURE_ACCESS = {
  'ai_study_pack': ['plus', 'pro', 'elite'],
  'ai_tutor': ['pro', 'elite'],
  'ai_essay_grader': ['elite']
}

function isAllowed(plan, type) {
  if (!type) return true // default allow
  return (FEATURE_ACCESS[type] || []).includes(plan)
}

app.post('/', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) return c.json({ error: 'Missing Authorization header' }, 401)

  const token = authHeader.replace('Bearer ', '')
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return c.json({ error: 'Invalid token' }, 401)

  const { prompt, model = 'gemini-1.5-flash', history = [], type } = await c.req.json()

  // Fetch user profile for plan
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, email')
    .eq('id', user.id)
    .single()

  const plan = profile?.plan || 'free'

  if (!isAllowed(plan, type)) {
    return c.json({ error: 'Upgrade required for this AI feature' }, 403)
  }

  try {
    const genAI = new GoogleGenerativeAI(c.env.GEMINI_API_KEY)
    const geminiModel = genAI.getGenerativeModel({ model })

    const chat = geminiModel.startChat({
      history: history.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      }))
    })

    const result = await chat.sendMessage(prompt)
    const response = await result.response
    const text = response.text()

    // Log usage non-fatally
    try {
      await supabase.from('ai_usage_logs').insert({
        user_id: user.id,
        email: profile?.email,
        model,
        feature_type: type,
        prompt_length: prompt.length,
        response_length: text.length,
        plan
      })
    } catch (logError) {
      console.error('Usage logging failed:', logError)
    }

    return c.json({ text })
  } catch (err) {
    console.error('AI Error:', err)
    return c.json({ error: 'AI request failed' }, 500)
  }
})

export default app
