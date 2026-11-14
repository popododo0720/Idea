import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdater, compareVersions, repoOf, rawUrl, commitsUrl, updateCommand, isVersion, CHECK_EVERY_MS, MIN_GAP_MS, DEFAULT_SPEC } from '../lib/update.js'

const logger = () => { const l = []; return { warn: (...a) => l.push(a), logs: l } }
const pkgFetch = (calls, version = '0.9.0') => async url => {
  calls.push(url)
  return { ok: true, status: 200, text: async () => JSON.stringify({ version }) }
}

test('compareVersions is numeric per part', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.8.7', '0.8.7'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
})

test('only X.Y.Z versions are accepted', () => {
  for (const v of ['1.2.3', '0.0.0']) assert.ok(isVersion(v))
  for (const v of ['1.2', '1.2.3-rc.1', 'v1.2.3', '1.2.3\n', 1, undefined, '1.2.x']) assert.ok(!isVersion(v), String(v))
})

test('repoOf reads the installed spec and falls back to the default', () => {
  assert.deepEqual(repoOf(DEFAULT_SPEC), { owner: 'popododo0720', repo: 'Idea', ref: 'main', dir: 'plugins/idea' })
  assert.deepEqual(repoOf('github:me/fork#dev&path:/plugins/idea'), { owner: 'me', repo: 'fork', ref: 'dev', dir: 'plugins/idea' })
  assert.deepEqual(repoOf('git+https://github.com/me/fork.git#path:/plugins/idea'), { owner: 'me', repo: 'fork', ref: 'main', dir: 'plugins/idea' })
  assert.deepEqual(repoOf('github:me/fork#../x'), { owner: 'me', repo: 'fork', ref: 'main', dir: '' })
  assert.equal(repoOf('/some/local/path').owner, 'popododo0720')
  assert.equal(repoOf(undefined).repo, 'Idea')
  const r = repoOf(DEFAULT_SPEC)
  assert.equal(rawUrl(r), 'https://raw.githubusercontent.com/popododo0720/Idea/main/plugins/idea/package.json')
  assert.equal(commitsUrl(r), 'https://github.com/popododo0720/Idea/commits/main')
  assert.equal(rawUrl(repoOf('github:a/b')), 'https://raw.githubusercontent.com/a/b/main/package.json')
})

test('checks are never more often than every 10 minutes, and the timers run at start and every 6 hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const calls = []
  let clock = 0
  const u = createUpdater({ ctx: { logger: logger() }, fetchImpl: pkgFetch(calls), now: () => clock, installed: '0.8.7', env: {} })
  u.start()
  t.mock.timers.tick(5_000)
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 1)
  clock = MIN_GAP_MS - 1
  await u.check()
  assert.equal(calls.length, 1)
  clock = MIN_GAP_MS
  await u.check()
  assert.equal(calls.length, 2)
  clock = 1e9
  t.mock.timers.tick(CHECK_EVERY_MS)
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 3)
  u.stop()
  t.mock.timers.tick(CHECK_EVERY_MS * 2)
  assert.equal(calls.length, 3)
})

test('network errors are logged once and keep the old state', async () => {
  const log = logger()
  let clock = 0
  const u = createUpdater({ ctx: { logger: log }, fetchImpl: async () => { throw new Error('offline') }, now: () => clock, installed: '0.8.7', env: {} })
  for (let i = 0; i < 3; i++) { await u.check(); clock += MIN_GAP_MS }
  assert.equal(log.logs.length, 1)
  assert.deepEqual([u.state().latest, u.state().available], [null, false])
})

test('a bad status or bad version is ignored', async () => {
  const log = logger()
  let clock = 0
  let reply
  const u = createUpdater({ ctx: { logger: log }, fetchImpl: async () => reply, now: () => clock, installed: '0.8.7', env: {} })
  for (const r of [
    { ok: false, status: 404, text: async () => '' },
    { ok: true, status: 200, text: async () => JSON.stringify({ version: '9.9.9-evil' }) },
    { ok: true, status: 200, text: async () => 'not json' },
  ]) { reply = r; await u.check(); clock += MIN_GAP_MS }
  assert.equal(u.state().latest, null)
  assert.equal(log.logs.length, 1)
})

test('banner state: available only when the latest is newer', async () => {
  let clock = 0
  let version = '0.8.7'
  const u = createUpdater({ ctx: { logger: logger() }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version }) }), now: () => clock, installed: '0.8.7', env: {}, source: async () => 'github:me/fork#dev' })
  await u.check()
  assert.equal(u.state().available, false)
  clock += MIN_GAP_MS
  version = '0.8.10'
  await u.check()
  assert.deepEqual(u.state(), { installed: '0.8.7', latest: '0.8.10', available: true, commits: 'https://github.com/me/fork/commits/dev', running: false, result: null })
})

test('a failing spec source falls back to the default repository', async () => {
  const calls = []
  const u = createUpdater({ ctx: { logger: logger() }, fetchImpl: pkgFetch(calls), installed: '0.8.7', env: {}, source: async () => { throw new Error('x') } })
  await u.check()
  assert.match(calls[0], /popododo0720\/Idea\/main\/plugins\/idea\/package\.json$/)
})

test('updateCommand is an argument array run with the running dsh', () => {
  const spec = 'github:a/b#path:/plugins/idea; rm -rf /'
  assert.deepEqual(
    updateCommand({ env: { DSH_PROFILE: 'web', DSH_NODE_EXECUTABLE: '/usr/bin/node' }, argv: ['node', '/usr/bin/dsh'], execPath: '/x/node', spec }),
    { file: '/usr/bin/node', args: ['/usr/bin/dsh', 'plugin', '--profile', 'web', 'add', spec] })
  assert.deepEqual(
    updateCommand({ env: { DSH_PROFILE_DIR: '/h/profiles/p1/' }, argv: ['dsh'], execPath: '/bin/dsh', spec: 's' }),
    { file: '/bin/dsh', args: ['plugin', '--profile', 'p1', 'add', 's'] })
  assert.equal(updateCommand({ env: {}, argv: [], execPath: '/bin/dsh', spec: 's' }), undefined)
})

test('apply runs execFile with no shell and reports success', async () => {
  const seen = []
  const execFile = (file, args, opts, cb) => { seen.push([file, args, opts]); cb(null, 'ok', '') }
  const u = createUpdater({ ctx: { logger: logger() }, execFile, installed: '0.8.7', env: { DSH_PROFILE: 'web', DSH_NODE_EXECUTABLE: '/n' }, argv: ['n', '/d'], source: async () => 'github:me/fork' })
  await u.specNow()
  const r = await u.apply()
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(seen[0].slice(0, 2), ['/n', ['/d', 'plugin', '--profile', 'web', 'add', 'github:me/fork']])
  assert.ok(!('shell' in seen[0][2]) && seen[0][2].timeout > 0)
  assert.deepEqual(u.state().result, { ok: true })
})

test('apply reports the exit code and the last stderr lines on failure', async () => {
  const stderr = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const execFile = (_f, _a, _o, cb) => cb(Object.assign(new Error('failed'), { code: 3 }), '', stderr)
  const u = createUpdater({ ctx: { logger: logger() }, execFile, installed: '0.8.7', env: { DSH_PROFILE: 'web' } })
  const r = await u.apply()
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
  assert.equal(r.stderr.split('\n').length, 8)
  assert.ok(r.stderr.endsWith('line 19'))
  const timedOut = createUpdater({ ctx: { logger: logger() }, execFile: (_f, _a, _o, cb) => cb(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '', ''), installed: '0.8.7', env: { DSH_PROFILE: 'web' } })
  const t = await timedOut.apply()
  assert.deepEqual([t.code, t.stderr], [null, 'timed out'])
})

test('apply without a known profile fails without running anything, and runs one at a time', async () => {
  let ran = 0
  let finish
  const execFile = (_f, _a, _o, cb) => { ran++; finish = cb }
  const none = createUpdater({ ctx: { logger: logger() }, execFile, installed: '0.8.7', env: {} })
  assert.equal((await none.apply()).ok, false)
  assert.equal(ran, 0)
  const u = createUpdater({ ctx: { logger: logger() }, execFile, installed: '0.8.7', env: { DSH_PROFILE: 'web' } })
  const first = u.apply()
  assert.equal(u.state().running, true)
  assert.equal((await u.apply()).ok, false)
  finish(null, '', '')
  assert.equal((await first).ok, true)
  assert.equal(ran, 1)
})
