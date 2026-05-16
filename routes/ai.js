/**
 * /ai — Gemini proxy with usage logging
 * Compatible with Cloudflare Workers / Hono
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const app = new Hono()

// Role-based access for AI features
const FEATURE_ACCESS = {
  'ai_study_pack': ['plus', 'pro', 'elite'],
  'ai_tutor': ['pro', 'elite'],
  'ai_essay_grader': ['elite']
}

function isAllowed(plan, type) {
  if (!type) return true;
  const allowedPlans = FEATURE_ACCESS[type] || [];
  return allowedPlans.includes(plan);
}

app.post('/', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) return c.json({ error: 'Missing Authorization header' }, 401)

  const token = authHeader.replace('Bearer ', '')
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return c.json({ error: 'Invalid token' }, 401)

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { prompt, model = 'gemini-1.5-flash', history, type } = body;

  // Fetch user profile for plan check
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', user.id)
    .single()

  const userPlan = profile?.plan || 'free'

  if (!isAllowed(userPlan, type)) {
    return c.json({ error: 'Feature not included in your plan' }, 403)
  }

  // Check quota
  const today = new Date().toISOString().split('T')[0]
  const { data: usage } = await supabase
    .from('ai_usage')
    .select('count')
    .eq('user_id', user.id)
    .eq('date', today)
    .single()

  const dailyLimit = (userPlan === 'free') ? 5 : 100
  if (usage && usage.count >= dailyLimit) {
    return c.json({ error: 'Daily quota exceeded' }, 429)
  }

  try {
    const genAI = new GoogleGenerativeAI(c.env.GEMINI_API_KEY)
    const geminiModel = genAI.getGenerativeModel({ model })

    let result;
    if (history) {
      const chat = geminiModel.startChat({ history });
      result = await chat.sendMessage(prompt);
    } else {
      result = await geminiModel.generateContent(prompt);
    }
    
    const responseText = result.response.text()

    // Log usage (non-blocking)
    if (usage) {
      await supabase.from('ai_usage').update({ count: usage.count + 1 }).eq('user_id', user.id).eq('date', today)
    } else {
      await supabase.from('ai_usage').insert({ user_id: user.id, date: today, count: 1 })
    }

    return c.json({ text: responseText })
  } catch (err) {
    console.error('AI Error:', err)
    return c.json({ error: 'AI processing failed', details: err.message }, 500)
  }
})

export default app
