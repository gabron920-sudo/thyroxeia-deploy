// Guards item 5: the frontend must never write HTML strings into the DOM.
// 1) Static scan: no innerHTML / outerHTML / insertAdjacentHTML / document.write.
// 2) Behavioural test: the shipped renderer (extracted from index.html) escapes
//    markup from untrusted text and builds real nodes instead.
import { readFileSync } from 'node:fs'

const HTML_PATH = '/tmp/hey/public_fixed12/index.html'
const html = readFileSync(HTML_PATH, 'utf8')

let failed = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}

// ── 1. Static scan ───────────────────────────────────────────────────────────
for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
  const hits = html.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => line.includes(banned))
  check(`no ${banned} in public_fixed12/index.html`, hits.length === 0,
    hits.map(([n]) => `line ${n}`).join(', '))
}

// ── 2. Behavioural test of the shipped helpers ───────────────────────────────
const start = html.indexOf('// ─── SAFE DOM BUILDERS')
const end = html.indexOf("document.addEventListener('keydown'", start)
check('helper block located in index.html', start !== -1 && end > start)
const block = html.slice(start, end)

// Minimal DOM stub — enough for the real helpers to run.
class StubText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text) }
  get text() { return this.textContent }
}
class StubElement {
  constructor(tag) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.listeners = {}
    this._text = ''
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new StubText(n) : n)
  }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes) }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  set textContent(value) { this.childNodes = []; this._text = String(value); if (value !== '') this.childNodes.push(new StubText(value)) }
  get textContent() { return this.childNodes.map(n => (n.nodeType === 3 ? n.textContent : n.textContent)).join('') }
  get className() { return this.attributes.class || '' }
  set className(v) { this.attributes.class = v }
  // serialise so we can assert nothing became an element
  toHTML() {
    const attrs = Object.entries(this.attributes).map(([k, v]) => ` ${k}="${v}"`).join('')
    return `<${this.tagName.toLowerCase()}${attrs}>${this.childNodes.map(n => (n.nodeType === 3 ? n.textContent : n.toHTML())).join('')}</${this.tagName.toLowerCase()}>`
  }
}
const documentStub = {
  createElement: (tag) => new StubElement(tag),
  createTextNode: (text) => new StubText(text),
}
const { h, renderAiMarkdownInto } = new Function('document', `${block}\nreturn { h, renderAiMarkdownInto }`)(documentStub)

// h() must treat text as text, never as markup
const evil = '<img src=x onerror=alert(1)>'
const node = h('div', { class: 'x', text: evil })
check('h() stores untrusted text as a text node', node.childNodes.length === 1 && node.childNodes[0].nodeType === 3)
check('h() creates no img element from text', node.toHTML() === `<div class="x">${evil}</div>`, node.toHTML())

// Script payload through the markdown renderer
const container = new StubElement('div')
renderAiMarkdownInto(container, '<script>alert(1)</script>\n**bold move**\n## Heading\n- bullet\n1. first')
const rendered = container.toHTML()
check('renderer keeps <script> as literal text', container.textContent.includes('<script>alert(1)</script>'))
const tags = (node, acc = []) => {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) { acc.push(child.tagName); tags(child, acc) }
  }
  return acc
}
check('renderer creates no SCRIPT/IMG elements', !tags(container).includes('SCRIPT') && !tags(container).includes('IMG'), tags(container).join(','))
check('renderer still applies bold', rendered.includes('<strong>bold move</strong>'))
check('renderer still styles headings', rendered.includes('color:var(--primary-light)') && rendered.includes('Heading'))
check('renderer still renders bullets', container.textContent.includes('• bullet'))
check('renderer numbers list items', rendered.includes('<strong>1. </strong>first'))

// Even a fully hostile string cannot introduce an element
const hostile = new StubElement('div')
renderAiMarkdownInto(hostile, '</div><svg/onload=alert(1)><b>x</b>')
check('closing tags in output cannot break out', hostile.childNodes.every(n => n.nodeType === 3 || n.tagName === 'DIV'))

console.log(failed === 0 ? '\nAll DOM-safety tests passed.' : `\n${failed} test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
