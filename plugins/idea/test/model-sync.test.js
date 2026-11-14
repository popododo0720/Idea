import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelSync, internals } from '../lib/model-sync.js'
import { waitFor } from './helpers.js'

const { keyRefs } = internals
const DEBOUNCE_MS = 1500

test('keyRefs finds every valid apiKeyEnv name, nested anywhere', () => {
  const value = {
    apiKeyEnv: 'TOP_KEY',
    routes: [
      { name: 'a', apiKeyEnv: 'OPENAI_API_KEY' },
      { name: 'b', nested: { deeper: [{ apiKeyEnv: '_X1' }] } },
      { apiKeyEnv: 'not valid' },
      { apiKeyEnv: '1STARTS_WITH_DIGIT' },
      { apiKeyEnv: 42 },
      { apiKeyEnv: { apiKeyEnv: 'INSIDE' } },
    ],
    other: 'apiKeyEnv',
  }
  assert.deepEqual([...keyRefs(value)].sort(), ['INSIDE', 'OPENAI_API_KEY', 'TOP_KEY', '_X1'])
  assert.deepEqual([...keyRefs(null)], [])
  assert.deepEqual([...keyRefs('apiKeyEnv')], [])
})

/**
 * A minimal plugin context with the settings and credentials services the
 * sync reads, and a fake machine that records what it receives.
 */
function harness(t, { describe, keys = {}, records = {}, unreadable = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = {
    describe: describe || [
      { ns: 'llm-deepseek', user: { model: 'deepseek-chat', apiKeyEnv: 'DS_KEY' }, value: { model: 'deepseek-chat', apiKeyEnv: 'DS_KEY' } },
      { ns: 'llm-pi-ai', user: {}, value: { routes: [{ apiKeyEnv: 'OPENAI_API_KEY' }, { apiKeyEnv: 'EMPTY_KEY' }, { apiKeyEnv: 'BROKEN_KEY' }] } },
      { ns: 'appearance', user: { theme: 'dark' }, value: { apiKeyEnv: 'UNRELATED_KEY' } },
    ],
    keys: { DEEPSEEK_API_KEY: 'sk-ds-secret', DS_KEY: 'sk-ds2-secret', OPENAI_API_KEY: 'sk-oa-secret', EMPTY_KEY: '', UNRELATED_KEY: 'sk-unrelated-secret', ...keys },
    records: { 'deepseek-account-platform/default': { token: 'acct-secret' }, 'other-plugin/record': { token: 'other-secret' }, ...records },
    unreadable: new Set(['BROKEN_KEY', ...unreadable]),
    paired: true,
    recordsStatus: 200,
  }
  const handlers = {}
  const disposers = []
  const logs = []
  const settings = { describe: () => state.describe }
  const credentials = {
    resolve: async ref => {
      if (state.unreadable.has(ref)) throw new Error('locked: ' + ref)
      return ref in state.keys ? { value: state.keys[ref] } : undefined
    },
    listRecords: async () => Object.keys(state.records).map(key => ({ key })),
    readRecord: async key => state.records[key],
  }
  const services = { settings, credentials }
  const ctx = {
    get: name => services[name],
    on: (event, fn) => { (handlers[event] ||= []).push(fn) },
    effect: fn => { disposers.push(fn()) },
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
    },
  }
  t.after(() => { for (const d of disposers) d() })
  const rpcs = []
  const puts = []
  const sync = createModelSync({
    ctx,
    rpc: async (method, args) => { rpcs.push([method, args]); return {} },
    json: async (method, path, value) => { puts.push([method, path, value]); return { status: state.recordsStatus, text: '{}' } },
    paired: async () => state.paired,
  })
  // One debounced round, run to the end (a log line closes every round that sends).
  const round = async () => {
    const before = logs.length
    t.mock.timers.tick(DEBOUNCE_MS)
    await waitFor(() => logs.length > before)
    return logs.at(-1)
  }
  const emit = (event, arg) => { for (const fn of handlers[event] || []) fn(arg) }
  return { sync, state, rpcs, puts, logs, round, emit, services }
}

test('the user model sections, their keys and the DeepSeek sign-in are sent to the machine', async t => {
  const h = harness(t)
  h.sync.schedule()
  const [level, , ...counts] = await h.round()
  assert.equal(level, 'info')
  assert.deepEqual(counts, [1, 3, 1])
  const settings = h.rpcs.filter(([m]) => m === 'settings/replace').map(([, a]) => a)
  assert.deepEqual(settings, [{ ns: 'llm-deepseek', section: { model: 'deepseek-chat', apiKeyEnv: 'DS_KEY' }, expectedRevision: undefined }],
    'an empty section and other namespaces are left alone')
  const keys = Object.fromEntries(h.rpcs.filter(([m]) => m === 'credentials/set').map(([, a]) => [a.ref, a.value]))
  assert.deepEqual(keys, { DEEPSEEK_API_KEY: 'sk-ds-secret', DS_KEY: 'sk-ds2-secret', OPENAI_API_KEY: 'sk-oa-secret' },
    'empty, unreadable and unreferenced keys are not sent')
  assert.deepEqual(h.puts, [['PUT', '/idea-sync/records', { records: { 'deepseek-account-platform/default': { token: 'acct-secret' } } }]])
})

test('a changed credential sends the new state', async t => {
  const h = harness(t)
  h.sync.schedule()
  await h.round()
  const sent = h.rpcs.length
  h.state.keys.DS_KEY = 'sk-ds2-rotated'
  h.emit('credentials/reference-updated')
  await h.round()
  assert.deepEqual(h.rpcs.slice(sent).find(([m, a]) => m === 'credentials/set' && a.ref === 'DS_KEY'), ['credentials/set', { ref: 'DS_KEY', value: 'sk-ds2-rotated' }])
})

test('an unchanged round sends nothing', async t => {
  const h = harness(t)
  h.sync.schedule()
  await h.round()
  const [rpcs, puts, logs] = [h.rpcs.length, h.puts.length, h.logs.length]
  let listed = 0
  const list = h.services.credentials.listRecords
  h.services.credentials.listRecords = async () => { listed++; return list() }
  h.sync.schedule()
  t.mock.timers.tick(DEBOUNCE_MS)
  await waitFor(() => listed === 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([h.rpcs.length, h.puts.length, h.logs.length], [rpcs, puts, logs])
})

test('quick successive changes collapse into one round', async t => {
  const h = harness(t)
  let collected = 0
  h.services.settings.describe = () => { collected++; return h.state.describe }
  h.emit('settings/document-updated', 'llm-deepseek')
  h.emit('settings/document-updated', 'llm-pi-ai')
  h.emit('credentials/record-updated', 'deepseek-account-platform/default')
  h.sync.schedule()
  await h.round()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(collected, 1)
  assert.equal(h.puts.length, 1)
  assert.equal(h.rpcs.filter(([m]) => m === 'settings/replace').length, 1)
})

test('events about other settings or records do not start a round', async t => {
  const h = harness(t)
  let collected = 0
  h.services.settings.describe = () => { collected++; return h.state.describe }
  h.emit('settings/document-updated', 'appearance')
  h.emit('credentials/record-updated', 'other-plugin/record')
  t.mock.timers.tick(DEBOUNCE_MS * 2)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(collected, 0)
  assert.equal(h.rpcs.length, 0)
})

test('nothing is read or sent while unpaired, or without the settings services', async t => {
  const h = harness(t)
  h.state.paired = false
  let collected = 0
  h.services.settings.describe = () => { collected++; return h.state.describe }
  h.sync.schedule()
  t.mock.timers.tick(DEBOUNCE_MS)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(collected, 0)
  h.state.paired = true
  delete h.services.credentials
  h.sync.schedule()
  t.mock.timers.tick(DEBOUNCE_MS)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(collected, 0)
  assert.deepEqual([h.rpcs.length, h.puts.length, h.logs.length], [0, 0, 0])
})

test('a refused sign-in upload is logged and retried next time; reset() sends everything again', async t => {
  const h = harness(t)
  h.state.recordsStatus = 500
  h.sync.schedule()
  const [level, msg, reason] = await h.round()
  assert.equal(level, 'warn')
  assert.match(msg, /could not send model settings/)
  assert.equal(reason, 'sign-ins: the machine dsh answered HTTP 500')
  h.state.recordsStatus = 200
  h.sync.schedule()
  assert.equal((await h.round())[0], 'info')
  assert.equal(h.puts.length, 2, 'the failed round did not count as sent')
  const before = h.rpcs.length
  h.sync.reset()
  h.sync.schedule()
  await h.round()
  assert.equal(h.rpcs.length - before, 4, 'the section and all three keys again')
  assert.equal(h.puts.length, 3)
})

test('no key, token or record value ever reaches the log', async t => {
  const h = harness(t)
  h.sync.schedule()
  await h.round()
  h.state.recordsStatus = 403
  h.state.keys.DS_KEY = 'sk-changed-secret'
  h.sync.schedule()
  await h.round()
  const text = JSON.stringify(h.logs)
  for (const secret of ['sk-ds-secret', 'sk-ds2-secret', 'sk-oa-secret', 'sk-changed-secret', 'acct-secret', 'other-secret', 'sk-unrelated-secret']) {
    assert.ok(!text.includes(secret), `${secret} is in the log`)
  }
  assert.ok(!JSON.stringify(h.puts).includes('other-secret'), 'records of other plugins stay here')
})
