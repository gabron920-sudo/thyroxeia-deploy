 import { Hono } from 'hono'
import { cors } from 'hono/cors'
import aiRouter from './routes/ai.js'
import authRouter from './routes/auth-email.js'
import paymentRouter from './routes/payment.js'
import adminRouter from './routes/admin.js'


const app = new Hono()


function patchHtml(html) {
  const oldPayPalContainer = String.raw`<div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime.</p>`


  const newPayPalContainer = String.raw`<label style="display:flex;gap:10px;align-items:flex-start;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:12px;margin-bottom:16px;cursor:pointer">
      <input type="checkbox" id="no-refunds-ack" onchange="handleNoRefundsAck()" style="margin-top:2px;accent-color:#ef4444" />
      <span class="text-xs" style="color:var(--text2);line-height:1.5"><strong style="color:#ef4444">No refunds:</strong> I understand purchases are non-refundable for the current billing period. I can cancel anytime to stop future renewals.</span>
    </label>
    <div id="paypal-button-container" style="min-height:50px"></div>
    <p class="text-xs text-center mt-4" style="color:var(--text3)">🔒 Secure payment via PayPal. Cancel anytime to stop future renewals. No refunds for the current billing period.</p>`


  const oldRenderStart = String.raw`function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')`


  const newRenderStart = String.raw`function handleNoRefundsAck() { if (pendingPlan) renderPayPal(pendingPlan) }
function renderPayPal(plan) {
  const container = document.getElementById('paypal-button-container')
  const noRefundsAck = document.getElementById('no-refunds-ack')
  if (!noRefundsAck || !noRefundsAck.checked) {
    container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text3);border:1px dashed var(--border);border-radius:12px">Check the no-refunds acknowledgement above to continue to PayPal.</div>'
    return
  }`


  return html
    .replace(/
\s*timed:\s*\['student','pro','elite'\],/g, '')
    .replace(/ 
