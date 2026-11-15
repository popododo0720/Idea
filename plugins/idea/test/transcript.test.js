import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RESULT, MAX_TEXT, PAGE_MESSAGES, redact, renderEvents, summarize, transcriptPage } from '../lib/transcript.js'

const ev = (seq, type, data) => ({ type, seq, time: Date.UTC(2026, 0, 1, 0, 0, seq), data })
const msg = (role, text, source = { kind: 'user' }) => ({ id: 'm', role, source, content: [{ type: 'text', text }] })
const rec = e => ({ type: 'event', event: e })

const FAKE_KEYS = [
  'sk-' + 'a1b2c3d4e5f6g7h8i9j0',
  'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2',
  'glpat-' + 'abcdefghij0123456789',
  'AKIA' + 'ABCDEFGHIJKLMNOP',
  'eyJ' + 'hbGciOiJIUzI1.eyJzdWIiOiIx' + 'MjM0NTY3.SflKxwRJSMeKKF2QT4',
  'a'.repeat(40),
]

test('redact masks credential-looking values and keeps the rest', () => {
  for (const key of FAKE_KEYS) {
    const out = redact(`use ${key} now`)
    assert.ok(!out.includes(key), key.slice(0, 6))
    assert.match(out, /^use \[redacted\] now$/)
  }
  const word = ['abcdef', '123456'].join('')
  const header = ['Author', 'ization'].join('')
  assert.equal(redact(`curl -H "${header}: ${['Bea', 'rer'].join('')} ${word}" x`), `curl -H "${header}: Bearer [redacted]" x`)
  const envName = ['API', 'KEY'].join('_')
  assert.equal(redact(`${envName}=${['hunter', '2hunter2'].join('')} npm test`), `${envName}=[redacted] npm test`)
  const horse = ['correct', 'horse'].join('')
  assert.ok(!redact(`{"${['pass', 'word'].join('')}": "${horse}"}`).includes(horse))
  const pw = ['s3cret', 'pass'].join('')
  assert.equal(redact(`git clone ${['https', '://'].join('')}bot:${pw}@host/x.git`), `git clone ${['https', '://'].join('')}bot:[redacted]@host/x.git`)
  const pem = ['-----BEGIN OPENSSH PRIV', 'ATE KEY-----'].join('')
  assert.ok(!redact(`${pem}\nabc\n-----END OPENSSH PRIVATE KEY-----`).includes('abc'))
  const plain = 'ls -la src/lib && git status --short (tokens: 3)'
  assert.equal(redact(plain), plain)
})

test('summarize gives one short, redacted line from the arguments', () => {
  assert.equal(summarize(JSON.stringify({ command: 'ls -la\n  src' })), 'ls -la src')
  assert.equal(summarize(JSON.stringify({ file_path: '/work/a.js', content: 'x' })), '/work/a.js')
  assert.equal(summarize('not json'), 'not json')
  assert.equal(summarize(JSON.stringify({ n: 1 })), '{"n":1}')
  assert.ok(summarize(JSON.stringify({ command: 'x'.repeat(500) })).length <= 161)
  assert.ok(!summarize(JSON.stringify({ command: `curl -u ${FAKE_KEYS[0]} host` })).includes(FAKE_KEYS[0]))
})

test('renderEvents: prompts, text, tool calls with results, errors, turn ends; no raw streams', () => {
  const rows = renderEvents([
    ev(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { message: msg('user', 'Fix the bug', { kind: 'user' }) }),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: msg('assistant', 'On it', { kind: 'model' }), stream: [{ big: 'chunk' }] }),
    ev(4, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: `echo ${FAKE_KEYS[1]}` }) }),
    ev(5, 'tool/result', { turn: 1, step: 1, message: { ...msg('tool', `out ${FAKE_KEYS[1]}`, { kind: 'tool' }), toolCallId: 'c1' } }),
    ev(6, 'assistant/attempt', { turn: 1, step: 1, stream: [{ x: 1 }] }),
    ev(7, 'user/message', { message: msg('user', 'conflict, rebase', { kind: 'controller' }) }),
    ev(8, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'E_X', message: `boom ${FAKE_KEYS[0]}` } } }),
  ])
  assert.deepEqual(rows.map(r => r.kind), ['user', 'assistant', 'tool', 'user', 'error', 'turn-end', 'turn-end'])
  assert.deepEqual(rows.map(r => r.seq), [2, 3, 4, 7, 8, 8, 9])
  assert.equal(rows[0].text, 'Fix the bug')
  assert.equal(rows[3].source, 'controller')
  const tool = rows[2]
  assert.equal(tool.name, 'bash')
  assert.equal(tool.summary, 'echo [redacted]')
  assert.equal(tool.result, 'out [redacted]')
  assert.equal(rows[4].text, 'E_X: boom [redacted]')
  const json = JSON.stringify(rows)
  for (const key of FAKE_KEYS.slice(0, 2)) assert.ok(!json.includes(key))
  assert.ok(!json.includes('chunk') && !json.includes('stream'))
})

test('renderEvents trims long text and results, and keeps a result whose call is on an older page', () => {
  const rows = renderEvents([
    ev(5, 'tool/result', { message: { ...msg('tool', 'y'.repeat(MAX_RESULT + 500)), toolCallId: 'old', isError: true } }),
    ev(6, 'assistant/message', { message: msg('assistant', 'z'.repeat(MAX_TEXT + 10)) }),
    ev(7, 'user/message', { message: msg('user', '   ') }),
    ev(8, 'weird/event', { a: 1 }),
    { type: 'tool/call', seq: 'bad', data: {} },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].callId, rows[0].resultTruncated, rows[0].isError, rows[0].resultLength], ['old', true, true, MAX_RESULT + 500])
  assert.equal(rows[0].result.length, MAX_RESULT + 1)
  assert.equal(rows[1].text.length, MAX_TEXT + 1)
})

test('transcriptPage asks for the newest page, then pages backwards with beforeSeq', async () => {
  const calls = []
  const log = Array.from({ length: 10 }, (_, i) => ev(i + 1, 'assistant/message', { message: msg('assistant', 'm' + (i + 1)) }))
  const view = {
    rpc: async (method, args) => {
      calls.push([method, args])
      const before = args.request.beforeSeq ?? 11
      const page = log.filter(e => e.seq < before).slice(-4)
      return { records: page.map(rec).reverse(), hasMore: page[0].seq > 1, cursor: 10 }
    },
  }
  const first = await transcriptPage({ view, session: 'idea-x' })
  assert.deepEqual(calls[0], ['session/events', { request: { address: { kind: 'session', sessionId: 'idea-x' }, maxMessages: PAGE_MESSAGES } }])
  assert.deepEqual(first.items.map(i => i.text), ['m7', 'm8', 'm9', 'm10'])
  assert.deepEqual([first.hasMore, first.oldest, first.newest], [true, 7, 10])
  const second = await transcriptPage({ view, session: 'idea-x', before: first.oldest })
  assert.equal(calls[1][1].request.beforeSeq, 7)
  assert.deepEqual(second.items.map(i => i.text), ['m3', 'm4', 'm5', 'm6'])
  const last = await transcriptPage({ view, session: 'idea-x', before: 3 })
  assert.deepEqual([last.items.length, last.hasMore], [2, false])
})

test('transcriptPage bounds the events per page, and times out on a silent VM', async () => {
  const many = Array.from({ length: 500 }, (_, i) => rec(ev(i + 1, 'assistant/message', { message: msg('assistant', 'm' + i) })))
  const page = await transcriptPage({ view: { rpc: async () => ({ records: many, hasMore: false }) }, session: 's' })
  assert.equal(page.items.length, 300)
  assert.deepEqual([page.hasMore, page.oldest, page.newest], [true, 201, 500])
  const empty = await transcriptPage({ view: { rpc: async () => ({ records: [], hasMore: false }) }, session: 's' })
  assert.deepEqual(empty, { items: [], hasMore: false, oldest: 0, newest: 0 })
  await assert.rejects(transcriptPage({ view: { rpc: () => new Promise(() => {}) }, session: 's', timeoutMs: 20 }), /no answer/)
})
