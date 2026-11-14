import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSubscriptionsSync, internals } from '../lib/subscriptions-sync.js'
import { tempDir, waitFor } from './helpers.js'

const { newerThere } = internals

const session = (expiresAt, tag = 'a') => ({ accessToken: `at-${tag}-secret`, refreshToken: `rt-${tag}-secret`, expiresAt })
const store = accounts => ({ claude: { accounts } })

test('newerThere: only valid machine sessions that are newer or missing here', () => {
  assert.equal(newerThere(store({ me: session(100) }), store({ me: session(200) })), true, 'newer there')
  assert.equal(newerThere(store({ me: session(200) }), store({ me: session(100) })), false, 'older there')
  assert.equal(newerThere(store({ me: session(100) }), store({ me: session(100) })), false, 'the same')
  assert.equal(newerThere(store({ me: session(100) }), store({ me: session(100), other: session(1) })), true, 'an account only there')
  assert.equal(newerThere({}, { codex: { accounts: { x: session(1) } } }), true, 'a provider only there')
  assert.equal(newerThere(undefined, store({ me: session(1) })), true)
  assert.equal(newerThere(store({ me: session(100) }), store({ me: { ...session(999), refreshToken: '' } })), false, 'an invalid session there')
  assert.equal(newerThere(store({ me: session(100) }), store({ me: { ...session(999), expiresAt: Infinity } })), false)
  assert.equal(newerThere({}, { unknown: { accounts: { x: session(1) } } }), false, 'providers it does not know')
  assert.equal(newerThere({}, { claude: {} }), false)
  assert.equal(newerThere({}, null), false)
})

/**
 * A dsh home in a temporary directory (DSH_HOME and HOME both point there, so
 * no real sign-in file is read), a plugin context, and a fake machine.
 */
async function harness(t, { auth, providerSettings } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const home = tempDir(t, 'idea-subs-')
  process.env.DSH_HOME = home
  process.env.HOME = home
  const dir = join(home, 'plugins', 'subscriptions')
  await mkdir(dir, { recursive: true })
  const authFile = join(dir, 'auth.json')
  if (auth !== undefined) await writeFile(authFile, typeof auth === 'string' ? auth : JSON.stringify(auth))
  if (providerSettings !== undefined) await writeFile(join(dir, 'provider-settings.json'), JSON.stringify(providerSettings))
  const state = { paired: true, pairedCalls: 0, answer: value => ({ status: 200, text: JSON.stringify({ auth: value.auth }) }) }
  const calls = []
  const logs = []
  const disposers = []
  const ctx = {
    effect: fn => { disposers.push(fn()) },
    logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
  }
  const dispose = () => { while (disposers.length) disposers.pop()() }
  t.after(dispose)
  const sync = createSubscriptionsSync({
    ctx,
    json: async (method, path, value) => { calls.push([method, path, value]); return state.answer(value) },
    paired: async () => { state.pairedCalls++; return state.paired },
  })
  const readAuth = async () => JSON.parse(await readFile(authFile, 'utf8'))
  return { sync, state, calls, logs, dir, authFile, readAuth, dispose }
}

test('the sign-ins and provider settings are sent, and not again while unchanged', async t => {
  const auth = store({ me: session(100) })
  const providerSettings = { claude: { displayName: 'Claude', models: ['m1'] } }
  const h = await harness(t, { auth, providerSettings })
  await h.sync.now()
  assert.deepEqual(h.calls, [['PUT', '/idea-sync/subscriptions', { auth, providerSettings }]])
  await h.sync.now()
  assert.equal(h.calls.length, 1)
  const changed = store({ me: session(150) })
  await writeFile(h.authFile, JSON.stringify(changed))
  await h.sync.now()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1][2].auth, changed)
  await writeFile(join(h.dir, 'provider-settings.json'), JSON.stringify({ claude: { displayName: 'Renamed' } }))
  await h.sync.now()
  assert.equal(h.calls.length, 3, 'a changed provider-settings.json is sent too')
  h.sync.reset()
  await h.sync.now()
  assert.equal(h.calls.length, 4, 'reset() sends again')
  assert.deepEqual(h.logs.map(l => l[0]), ['info', 'info', 'info', 'info'])
})

test('without provider-settings.json only the sign-ins go', async t => {
  const auth = store({ me: session(100) })
  const h = await harness(t, { auth })
  await h.sync.now()
  assert.deepEqual(h.calls[0][2], { auth })
})

test('sessions the machine refreshed are taken back into an owner-only file', async t => {
  const auth = { ...store({ me: session(100) }), codex: { accounts: {} } }
  const h = await harness(t, { auth })
  const merged = { claude: { accounts: { me: session(500, 'b') } }, codex: { accounts: { work: session(300, 'c') } } }
  h.state.answer = () => ({ status: 200, text: JSON.stringify({ auth: merged }) })
  await h.sync.now()
  assert.deepEqual(await h.readAuth(), merged)
  assert.equal((await stat(h.authFile)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(h.dir), ['auth.json'], 'no temporary file is left behind')
  assert.match(h.logs.at(-1)[1], /took back newer sessions/)
  await h.sync.now()
  assert.equal(h.calls.length, 1, 'what was taken back is not sent again')
})

test('an older or unreadable machine answer leaves the file alone', async t => {
  const auth = store({ me: session(500) })
  const h = await harness(t, { auth })
  h.state.answer = () => ({ status: 200, text: JSON.stringify({ auth: store({ me: session(100, 'old') }) }) })
  await h.sync.now()
  assert.deepEqual(await h.readAuth(), auth)
  h.sync.reset()
  h.state.answer = () => ({ status: 200, text: 'not json' })
  await h.sync.now()
  assert.deepEqual(await h.readAuth(), auth)
  assert.equal(h.logs.filter(l => l[0] === 'info').length, 2)
})

test('a sign-in written during the round is not overwritten, and is sent next round', async t => {
  const auth = store({ me: session(100) })
  const h = await harness(t, { auth })
  const meanwhile = store({ me: session(900, 'local') })
  h.state.answer = async () => {
    await writeFile(h.authFile, JSON.stringify(meanwhile))
    return { status: 200, text: JSON.stringify({ auth: store({ me: session(500, 'machine') }) }) }
  }
  await h.sync.now()
  assert.deepEqual(await h.readAuth(), meanwhile)
  h.state.answer = value => ({ status: 200, text: JSON.stringify({ auth: value.auth }) })
  await h.sync.now()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1][2].auth, meanwhile)
})

test('a refused upload is logged without any token and tried again', async t => {
  const auth = store({ me: session(100) })
  const h = await harness(t, { auth })
  h.state.answer = () => ({ status: 500, text: JSON.stringify({ error: 'boom' }) })
  await h.sync.now()
  assert.equal(h.logs.length, 1)
  assert.equal(h.logs[0][0], 'warn')
  assert.equal(h.logs[0][2], 'the machine dsh answered HTTP 500')
  h.state.answer = value => ({ status: 200, text: JSON.stringify({ auth: value.auth }) })
  await h.sync.now()
  assert.equal(h.calls.length, 2)
  assert.ok(!/secret/.test(JSON.stringify(h.logs)), 'a token value is in the log')
})

test('nothing is read or sent while unpaired, or without a valid sign-in file', async t => {
  const h = await harness(t)
  h.state.paired = false
  await h.sync.now()
  assert.equal(h.calls.length, 0)
  h.state.paired = true
  await h.sync.now()
  assert.equal(h.calls.length, 0, 'no auth.json')
  await writeFile(h.authFile, '{broken')
  await h.sync.now()
  await writeFile(h.authFile, '"a string"')
  await h.sync.now()
  assert.equal(h.calls.length, 0, 'not a JSON object')
  assert.equal(h.logs.length, 0)
})

test('two rounds started together send once', async t => {
  const h = await harness(t, { auth: store({ me: session(100) }) })
  await Promise.all([h.sync.now(), h.sync.now()])
  assert.equal(h.calls.length, 1)
  assert.equal(h.state.pairedCalls, 1, 'the second round did not start at all')
})

test('rounds start 2 s after start and every 30 s, and stop when the plugin is disposed', async t => {
  const h = await harness(t, { auth: store({ me: session(100) }) })
  t.mock.timers.tick(1999)
  assert.equal(h.state.pairedCalls, 0)
  t.mock.timers.tick(1)
  await waitFor(() => h.calls.length === 1)
  await writeFile(h.authFile, JSON.stringify(store({ me: session(200) })))
  t.mock.timers.tick(30_000)
  await waitFor(() => h.calls.length === 2)
  h.dispose()
  const before = h.state.pairedCalls
  t.mock.timers.tick(120_000)
  assert.equal(h.state.pairedCalls, before)
})

test('a plugin disposed right after start never syncs', async t => {
  const h = await harness(t, { auth: store({ me: session(100) }) })
  h.dispose()
  t.mock.timers.tick(60_000)
  assert.equal(h.state.pairedCalls, 0)
})
