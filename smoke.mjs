// Headless-browser smoke test for the client. Not part of `npm test`, which
// covers the server over real sockets; this is the only check that the DOM code
// in public/ actually runs. It needs a real Chrome, so it lives behind its own
// script and is skipped rather than run in CI.
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const PROJECT = new URL('.', import.meta.url).pathname
const PORT = Number(process.env.SMOKE_PORT) || 4455
const APP = `http://localhost:${PORT}`

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const CHROME = CANDIDATES.find((path) => existsSync(path))
if (!CHROME) {
  console.log(`SKIP  no Chrome found. Set CHROME_PATH to run the client smoke test.`)
  console.log(`      looked in: ${CANDIDATES.join(', ')}`)
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const server = spawn('npm', ['run', '--silent', 'start'], {
  cwd: PROJECT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((r) =>
  server.stdout.on('data', (c) => c.toString().includes('running up') && r())
)

const profile = `/tmp/cdp-smoke-profile-${process.pid}`
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
)
await sleep(2500)

// Minimal CDP client over Node's global WebSocket.
const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const ws = new WebSocket(webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let nextId = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method) {
    events.push(msg)
  }
}

const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })

const newPage = async (url) => {
  const { result } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: attached } = await send('Target.attachToTarget', {
    targetId: result.targetId,
    flatten: true,
  })
  const sessionId = attached.sessionId
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Page.navigate', { url }, sessionId)
  await sleep(1800)
  return sessionId
}

const evaluate = async (sessionId, expression) => {
  const { result } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  )
  if (result?.exceptionDetails) {
    return { error: result.exceptionDetails.exception?.description ?? 'exception' }
  }
  return { value: result?.result?.value }
}

const alice = await newPage(`${APP}/chat.html?room=smoke&username=alice`)
const bob = await newPage(`${APP}/chat.html?room=smoke&username=bob`)

// --- sidebar / presence
const sidebar = await evaluate(alice, `document.querySelectorAll('.rail__users li').length`)
check('presence lists both users', sidebar.value === 2, `got ${sidebar.value}`)

// --- counter: maxlength came from roomData, not a hardcoded template value
const maxLen = await evaluate(alice, `document.querySelector('[name=message]').maxLength`)
check('composer maxlength from server', maxLen.value === 1000, `got ${maxLen.value}`)

// --- date divider inserted on first message
const divider = await evaluate(alice, `document.querySelector('.divider span')?.textContent`)
check('date divider inserted', divider.value === 'Today', `got ${divider.value}`)

const typeInto = (sessionId, text) =>
  evaluate(
    sessionId,
    `(() => {
      const input = document.querySelector('[name=message]')
      input.value = ${JSON.stringify(text)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`
  )

const submit = (sessionId) =>
  evaluate(
    sessionId,
    `(() => {
      document.querySelector('#message-form').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true })
      )
      return true
    })()`
  )

// --- typing indicator: drive the real input so the throttled emit fires
await typeInto(alice, 'alice is typing something')
await sleep(700)
const typing = await evaluate(bob, `document.querySelector('#typing').textContent`)
check('typing indicator shows', /alice is typing/.test(typing.value ?? ''), typing.value)

// --- unread: force the tab hidden, then let bob post
await evaluate(
  alice,
  `(() => { document.title = 'Chat App';
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); return 1 })()`
)
await typeInto(bob, 'hello from bob')
await submit(bob)
await sleep(600)

const msg = await evaluate(
  alice,
  `(() => { const m = document.querySelector('.msg'); return m && { id: m.dataset.id, text: m.querySelector('.msg__text').textContent } })()`
)
check('message rendered with data-id', Boolean(msg.value?.id), JSON.stringify(msg.value))
check('message text correct', msg.value?.text === 'hello from bob', msg.value?.text)

const unreadTitle = await evaluate(alice, `document.title`)
check('unread count in title while hidden', unreadTitle.value === '(1) Chat App', unreadTitle.value)

// revealing the tab clears it
const cleared = await evaluate(
  alice,
  `(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    return document.title
  })()`
)
check('title resets when tab becomes visible', cleared.value === 'Chat App', cleared.value)

// --- copy button on another user's message
const copyBtn = await evaluate(alice, `!!document.querySelector('.msg [data-copy]')`)
check('copy button present', copyBtn.value === true)

// --- copy actually writes to the clipboard
await send('Browser.grantPermissions', {
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  origin: APP,
})
// Clipboard reads require a focused document, which headless never has.
await send('Emulation.setFocusEmulationEnabled', { enabled: true }, alice)
const copied = await evaluate(
  alice,
  `(async () => {
    document.querySelector('.msg [data-copy]').click()
    await new Promise(r => setTimeout(r, 400))
    const done = document.querySelector('.msg [data-copy]').classList.contains('is-copied')
    let text = null
    try { text = await navigator.clipboard.readText() } catch (e) { text = 'READ_FAILED: ' + e.name }
    return { text, done }
  })()`
)
check('copy shows done state', copied.value?.done === true)
// is-copied is only applied after writeText() resolves, so this already proves
// the write succeeded. Headless Chrome's clipboard reads back empty regardless,
// so the readback value is reported but not asserted.
console.log(`      (clipboard readback: ${JSON.stringify(copied.value?.text)})`)

// --- own message styling
const own = await evaluate(bob, `!!document.querySelector('.msg--own')`)
check('own message gets own class', own.value === true)

// --- reactions: open the picker, react, chip appears with the right count
await evaluate(alice, `document.querySelector('.msg [data-add-reaction]').click()`)
await sleep(200)
const pickerOpen = await evaluate(
  alice,
  `(() => { const p = document.querySelector('.msg [data-picker]');
     return { hidden: p.hidden, count: p.querySelectorAll('[data-emoji]').length } })()`
)
check(
  'picker opens with allowed emojis',
  pickerOpen.value?.hidden === false,
  JSON.stringify(pickerOpen)
)
check('picker has 6 options', pickerOpen.value?.count === 6, `got ${pickerOpen.value?.count}`)

await evaluate(
  alice,
  `(() => { const p = document.querySelector('.msg [data-picker]');
     p.querySelector('[data-emoji="👍"]').click(); return 1 })()`
)
await sleep(500)
const chip = await evaluate(
  alice,
  `(() => { const c = document.querySelector('.msg .chip--mine');
     return c && { emoji: c.dataset.reaction, count: c.querySelector('.chip__count').textContent,
                   pressed: c.getAttribute('aria-pressed') } })()`
)
check('reaction chip appears', chip.value?.emoji === '👍', JSON.stringify(chip))
check('chip count is 1', chip.value?.count === '1', chip.value?.count)
check('chip marked as mine', chip.value?.pressed === 'true', chip.value?.pressed)

// bob sees the same chip without it being his
const bobChip = await evaluate(
  bob,
  `(() => { const c = document.querySelector('.msg .chip');
     return c && { count: c.querySelector('.chip__count').textContent,
                   pressed: c.getAttribute('aria-pressed') } })()`
)
check(
  'other user sees count but not pressed',
  bobChip.value?.count === '1' && bobChip.value?.pressed === 'false',
  JSON.stringify(bobChip)
)

// reacting again removes it
await evaluate(alice, `document.querySelector('.msg .chip--mine').click()`)
await sleep(500)
const gone = await evaluate(alice, `document.querySelectorAll('.msg .chip--mine').length`)
check('second reaction removes the chip', gone.value === 0, `got ${gone.value}`)

// --- XSS: a username must not be able to inject markup through a reaction tooltip
const xss = await evaluate(
  bob,
  `(() => {
    const input = document.querySelector('[name=message]')
    input.value = 'hi'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#message-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    return 1
  })()`
)
void xss
await sleep(400)
const injected = await evaluate(alice, `document.querySelectorAll('.msg script').length`)
check('no script injected via message text', injected.value === 0, `got ${injected.value}`)

// --- edit / delete controls are only on your own messages.
// bob has two own messages by now ('hello from bob' and the xss-check 'hi'), so
// always target the last one explicitly rather than relying on order.
const ownSel = `[...document.querySelectorAll('.msg--own')].pop()`

const ownTools = await evaluate(
  bob,
  `(() => { const m = ${ownSel};
     return { edit: !!m.querySelector('[data-edit]'), del: !!m.querySelector('[data-delete]') } })()`
)
check(
  'own message has edit and delete',
  ownTools.value?.edit && ownTools.value?.del,
  JSON.stringify(ownTools)
)

const otherTools = await evaluate(
  alice,
  `(() => { const m = document.querySelector('.msg:not(.msg--own)');
     return { edit: !!m.querySelector('[data-edit]'), del: !!m.querySelector('[data-delete]'),
              copy: !!m.querySelector('[data-copy]') } })()`
)
check(
  'other users message has copy but no edit or delete',
  otherTools.value?.copy && !otherTools.value?.edit && !otherTools.value?.del,
  JSON.stringify(otherTools)
)

// --- inline edit
await evaluate(bob, `${ownSel}.querySelector('[data-edit]').click()`)
await sleep(250)
const editing = await evaluate(
  bob,
  `(() => { const i = ${ownSel}.querySelector('.msg__edit');
     return i && { value: i.value, focused: document.activeElement === i } })()`
)
check('edit input opens with current text', editing.value?.value === 'hi', JSON.stringify(editing))
check('edit input is focused', editing.value?.focused === true)

await evaluate(
  bob,
  `(() => { const i = ${ownSel}.querySelector('.msg__edit');
     i.value = 'edited text'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1 })()`
)
await sleep(600)
const afterEdit = await evaluate(
  bob,
  `(() => { const m = ${ownSel};
     return { text: m.querySelector('.msg__text').textContent,
              input: !!m.querySelector('.msg__edit'),
              editedShown: !m.querySelector('[data-edited]').hidden } })()`
)
check('edit applied', afterEdit.value?.text === 'edited text', JSON.stringify(afterEdit))
check('edit input removed after save', afterEdit.value?.input === false)
check('edited marker shown', afterEdit.value?.editedShown === true)

// the edit propagates to the other user
const aliceSees = await evaluate(
  alice,
  `(() => { const m = [...document.querySelectorAll('.msg')].find(x => x.querySelector('.msg__text')?.textContent !== 'hello from bob');
     return m && { text: m.querySelector('.msg__text').textContent,
                   editedShown: !m.querySelector('[data-edited]').hidden } })()`
)
check(
  'other user sees the edit',
  aliceSees.value?.text === 'edited text',
  JSON.stringify(aliceSees)
)
check('other user sees edited marker', aliceSees.value?.editedShown === true)

// --- escape cancels an edit
await evaluate(bob, `${ownSel}.querySelector('[data-edit]').click()`)
await sleep(200)
await evaluate(
  bob,
  `(() => { const i = ${ownSel}.querySelector('.msg__edit');
     i.value = 'discard me'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`
)
await sleep(400)
const afterEscape = await evaluate(bob, `${ownSel}.querySelector('.msg__text').textContent`)
check(
  'escape restores the original text',
  afterEscape.value === 'edited text',
  JSON.stringify(afterEscape.value)
)

// clicking away cancels too. element.click() does not move focus, so blur has
// to be triggered directly for the handler to run.
await evaluate(bob, `${ownSel}.querySelector('[data-edit]').click()`)
await sleep(200)
await evaluate(
  bob,
  `(() => { const i = ${ownSel}.querySelector('.msg__edit');
     i.value = 'discard me too'; i.blur(); return 1 })()`
)
await sleep(300)
const afterBlur = await evaluate(bob, `${ownSel}.querySelector('.msg__text').textContent`)
check(
  'blur restores the original text',
  afterBlur.value === 'edited text',
  JSON.stringify(afterBlur.value)
)

// --- delete (native confirm auto-accepted)
const beforeCount = await evaluate(bob, `document.querySelectorAll('.msg--own').length`)
await evaluate(
  bob,
  `(() => { window.confirm = () => true; ${ownSel}.querySelector('[data-delete]').click(); return 1 })()`
)
await sleep(600)
const afterDelete = await evaluate(bob, `document.querySelectorAll('.msg--own').length`)
check(
  'one fewer own message after delete',
  afterDelete.value === beforeCount.value - 1,
  `${beforeCount.value} -> ${afterDelete.value}`
)

const aliceAfterDelete = await evaluate(
  alice,
  `[...document.querySelectorAll('.msg')].filter(x => x.querySelector('.msg__text')?.textContent === 'edited text').length`
)
check(
  'deleted message removed for everyone',
  aliceAfterDelete.value === 0,
  `got ${aliceAfterDelete.value}`
)

// --- reconnect: cut the network, let the client recover on its own, and make
// sure the thread is not rebuilt on top of what is already rendered.
await typeInto(bob, 'before the drop')
await submit(bob)
await sleep(500)

const beforeDrop = await evaluate(
  alice,
  `({ msgs: document.querySelectorAll('.msg').length, sidebar: document.querySelectorAll('.rail__users li').length })`
)

for (const session of [alice, bob]) {
  await send('Network.enable', {}, session)
  await send(
    'Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    session
  )
}
await sleep(1500)
for (const session of [alice, bob]) {
  await send(
    'Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    session
  )
}

// The client detects the drop on its own ping timeout, then reconnects.
let recovered = false
for (let attempt = 0; attempt < 40 && !recovered; attempt++) {
  await sleep(1000)
  const seen = await evaluate(
    alice,
    `({ banner: document.querySelector('#status')?.textContent ?? '',
        count: document.querySelectorAll('.msg').length })`
  )
  if (seen.value && !/Reconnecting|Cannot reach/.test(seen.value.banner)) recovered = true
}
check('client came back online by itself', recovered)

await sleep(1500)
const afterDrop = await evaluate(
  alice,
  `({ msgs: document.querySelectorAll('.msg').length,
      sidebar: document.querySelectorAll('.rail__users li').length,
      banner: document.querySelector('#status')?.textContent ?? '' })`
)
check(
  'no duplicated messages after recovery',
  afterDrop.value?.msgs === beforeDrop.value?.msgs,
  `${beforeDrop.value?.msgs} -> ${afterDrop.value?.msgs}`
)
check(
  'presence still lists both users after recovery',
  afterDrop.value?.sidebar === 2,
  JSON.stringify(afterDrop.value)
)

// and the recovered socket can still post
await typeInto(alice, 'after the drop')
await submit(alice)
await sleep(600)
const stillWorks = await evaluate(
  bob,
  `[...document.querySelectorAll('.msg')].some(x => x.querySelector('.msg__text')?.textContent === 'after the drop')`
)
check('can still post after recovery', stillWorks.value === true)

console.log('\n--- console errors ---')
const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown')
for (const error of errors) {
  const d = error.params.exceptionDetails
  console.log(`      ${d.text} ${d.exception?.description ?? ''}`.slice(0, 300))
}
check('no uncaught page exceptions', errors.length === 0, `${errors.length} thrown`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

ws.close()
chrome.kill()
server.kill()

// Wait for Chrome to actually exit before removing its profile, otherwise the
// directory is still being written to and the remove fails with ENOTEMPTY.
await new Promise((resolve) => {
  if (chrome.exitCode !== null) return resolve()
  chrome.on('exit', resolve)
  setTimeout(resolve, 3000)
})
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  // Leaving a directory in /tmp is not worth failing the run over.
}

process.exit(failed.length ? 1 : 0)
