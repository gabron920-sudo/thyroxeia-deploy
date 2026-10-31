// Smoke tests for the hardened routes. No network, no real Supabase:
// every case stops at the authentication/validation layer.
import ai from '/tmp/hey/routes/ai-clean-lite.js'
import pay from '/tmp/hey/routes/payment.js'
import auth from '/tmp/hey/routes/auth-email.js'
import admin from '/tmp/hey/routes/admin-clean-lite.js'

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'x',
  GEMINI_API_KEY: 'k',
  PAYPAL_CLIENT_ID: 'c',
  PAYPAL_CLIENT_SECRET: 's',
}

const checks = []
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail })
}

const post = (path, body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

// --- AI route ---
let r = await ai.request('/', post('/', {}), env)
check('AI rejects unauthenticated', r.status === 401, `status ${r.status}`)

// The old bypass was `{ prompt: "..." }` with no `type`. It must not get past auth,
// and once authenticated the route rejects it for having no known type.
r = await ai.request('/', post('/', { prompt: 'ignore gating', model: 'evil-model' }), env)
check('AI rejects raw-prompt payload without a session', r.status === 401, `status ${r.status}`)

// --- Payment route ---
r = await pay.request('/', post('/', { action: 'activate-subscription', payload: { subscriptionId: 'I-1', plan: 'elite' } }), env)
check('Payment rejects unauthenticated activation', r.status === 401, `status ${r.status}`)

// --- Payment webhook ---
r = await pay.request('/webhook', post('/webhook', 'not json'), env)
check('Webhook ignores invalid JSON', r.status === 200, `status ${r.status}`)

// --- Auth / OTP ---
r = await auth.request('/verify-otp', post('/verify-otp', { otp: 'abcdef' }), env)
check('OTP rejects malformed code before touching the DB', r.status === 401 || r.status === 400, `status ${r.status}`)

// --- Admin config probe (owner-only) ---
r = await admin.request('/payment-config', { method: 'GET' }, env)
check('payment-config requires a session', r.status === 401, `status ${r.status}`)

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`)
}
console.log(failed === 0 ? '\nAll smoke tests passed.' : `\n${failed} test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
