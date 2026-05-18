/**
 * /admin — owner-only stats for users, plans, and payment proof.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_EMAILS   comma-separated list, e.g. owner@example.com,backup@example.com
 *
 * Endpoints:
 *   GET /admin/stats
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
}

async function getAdmin(c) {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return { error: 'Admin service not configured.', status: 500 }
  }

  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return { error: 'Authentication required.', status: 401 }

  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user?.email) return { error: 'Invalid or expired session.', status: 401 }

  const allowed = adminEmails(c.env)
  if (!allowed.length || !allowed.includes(user.email.toLowerCase())) {
    return { error: 'Admin access only.', status: 403 }
  }

  return { user, sb }
}


function getGeminiKeyNames(env) {
  return [1,2,3,4,5,6,7,8,9,10,11,12,13]
    .map(i => `GEMINI_API_KEY${i > 1 ? '_' + i : ''}`)
    .filter(name => !!env[name])
}

async function testGeminiKey(key, model = 'gemini-2.0-flash-lite') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK only.' }] }],
        generationConfig: { maxOutputTokens: 8 }
      })
    })
    const data = await res.json().catch(() => ({}))
    const message = data?.error?.message || ''
    let status = 'ok'
    if (!res.ok) {
      if (/quota|exceeded|rate/i.test(message) || res.status === 429) status = 'quota_or_rate_limited'
      else if (/API key not valid|invalid/i.test(message) || res.status === 400) status = 'invalid_or_restricted'
      else if (/not found|not supported/i.test(message) || res.status === 404) status = 'model_unavailable'
      else status = 'failed'
    }
    return { status, httpStatus: res.status, latencyMs: Date.now() - started, message: message.slice(0, 180) || null }
  } catch (e) {
    return { status: 'network_or_fetch_error', httpStatus: null, latencyMs: Date.now() - started, message: String(e.message || e).slice(0, 180) }
  }
}

app.get('/gemini-key-health', async (c) => {
  const { error, status } = await getAdmin(c)
  if (error) return c.json({ error }, status)

  const model = c.req.query('model') || 'gemini-2.0-flash-lite'
  const names = getGeminiKeyNames(c.env)
  const results = []
  for (const name of names) {
    const result = await testGeminiKey(c.env[name], model)
    results.push({ name, ...result })
  }
  return c.json({
    generatedAt: new Date().toISOString(),
    model,
    totalConfigured: names.length,
    ok: results.filter(r => r.status === 'ok').length,
    results
  })
})

app.get('/stats', async (c) => {
  const { sb, error, status } = await getAdmin(c)
  if (error) return c.json({ error }, status)

  const { data: profiles, error: profileErr } = await sb
    .from('profiles')
    .select('id, plan, subscription_status, subscription_plan, paypal_subscription_id, subscription_started_at, subscription_checked_at, current_period_end, created_at')
    .order('created_at', { ascending: false })
    .limit(5000)

  if (profileErr) return c.json({ error: profileErr.message }, 500)

  const rows = profiles || []
  const byPlan = { free: 0, student: 0, pro: 0, elite: 0, unknown: 0 }
  const byStatus = {}
  let activePaid = 0

  for (const p of rows) {
    const plan = String(p.plan || 'free').toLowerCase()
    if (Object.prototype.hasOwnProperty.call(byPlan, plan)) byPlan[plan]++
    else byPlan.unknown++

    const st = String(p.subscription_status || 'none').toLowerCase()
    byStatus[st] = (byStatus[st] || 0) + 1

    if (['student', 'pro', 'elite'].includes(plan) && ['active', 'activated'].includes(st)) {
      activePaid++
    }
  }

  const recentPaid = rows
    .filter(p => p.paypal_subscription_id || ['student', 'pro', 'elite'].includes(String(p.plan || '').toLowerCase()))
    .slice(0, 50)
    .map(p => ({
      userId: p.id,
      plan: p.plan || 'free',
      subscriptionStatus: p.subscription_status || 'none',
      subscriptionPlan: p.subscription_plan || null,
      paypalSubscriptionId: p.paypal_subscription_id || null,
      startedAt: p.subscription_started_at || null,
      checkedAt: p.subscription_checked_at || null,
      currentPeriodEnd: p.current_period_end || null,
      createdAt: p.created_at || null,
    }))

  return c.json({
    generatedAt: new Date().toISOString(),
    totals: {
      users: rows.length,
      activePaid,
      free: byPlan.free,
      student: byPlan.student,
      pro: byPlan.pro,
      elite: byPlan.elite,
    },
    byPlan,
    byStatus,
    recentPaid,
  })
})

export default app
