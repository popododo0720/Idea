import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { apply, internals } from '../lib/index.js'
import { git } from '../lib/git-local.js'
import { fingerprintOf } from '../lib/tls-pin.js'
import { close, hasOpenssl, listen, request, selfSigned, tempDir, waitFor } from './helpers.js'

const { normalizeUrl, FORWARD, fingerprint, toPem } = internals
const noOpenssl = !hasOpenssl() && 'openssl is not installed'

test('normalizeUrl keeps https://host[:port] and nothing else', () => {
  assert.equal(normalizeUrl('machine:30443'), 'https://machine:30443')
  assert.equal(normalizeUrl('  https://machine:30443/api/v1?x=1#y '), 'https://machine:30443')
  assert.equal(normalizeUrl('https://192.168.1.5:30443'), 'https://192.168.1.5:30443')
  assert.equal(normalizeUrl('https://machine:443'), 'https://machine')
  assert.equal(normalizeUrl('HTTPS://Machine.Example'), 'https://machine.example')
  for (const bad of ['http://machine:30443', 'ftp://machine', 'https://user:pw@machine', 'https://user@machine', '', '   ', 'https://', 'javascript:alert(1)', 'machine:notaport', undefined, null, 42, ['machine']]) {
    assert.equal(normalizeUrl(bad), undefined, String(bad))
  }
})

test('the FORWARD allow-list admits exactly the panel calls', () => {
  const allowed = (method, path) => FORWARD.some(([m, re]) => m === method && re.test(path))
  for (const [m, p] of [
    ['GET', '/status'], ['POST', '/projects'], ['POST', '/tasks'], ['GET', '/tasks/abc-123'],
    ['POST', '/tasks/abc-123/retry'], ['POST', '/tasks/abc/cancel'], ['PUT', '/keys'], ['GET', '/devices'],
    ['GET', '/vms'], ['GET', '/git/repos'], ['GET', '/git/repos/owner/name/pulls/7'], ['GET', '/git/a.b/c_d-e'],
    ['POST', '/git/repos/owner/my.repo/pulls/42/merge'], ['DELETE', '/devices/0123456789ab'],
  ]) assert.ok(allowed(m, p), `${m} ${p} should be allowed`)
  for (const [m, p] of [
    ['POST', '/status'], ['GET', '/status/'], ['GET', '/statusx'], ['GET', '/keys'], ['PUT', '/keys/x'],
    ['GET', '/tasks/ABC'], ['GET', '/tasks/a.b'], ['GET', '/tasks/../keys'], ['POST', '/tasks/abc/delete'],
    ['GET', '/tasks/' + 'a'.repeat(121)], ['DELETE', '/devices'], ['DELETE', '/devices/0123'], ['DELETE', '/devices/0123456789AB'],
    ['GET', '/git/../keys'], ['GET', '/git/repos/../../keys'], ['GET', '/git/a..b'], ['GET', '/git/a/%2e%2e/b'],
    ['GET', '/git/' + 'a'.repeat(301)], ['GET', '/git/a?b'], ['POST', '/git/repos/o/r/pulls/1'],
    ['POST', '/git/repos/o/r/pulls/x/merge'], ['POST', '/git/repos/o/r/pulls/1/merge/x'], ['PATCH', '/status'],
    ['GET', '/pair'], ['POST', '/pair'], ['GET', 'status'], ['GET', '//status'],
  ]) assert.ok(!allowed(m, p), `${m} ${p} should be refused`)
})

test('toPem turns the DER the machine presented back into the same certificate', { skip: noOpenssl }, () => {
  const { cert } = selfSigned()
  const raw = new X509Certificate(cert).raw
  const pem = toPem(raw)
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE-----\n$/)
  assert.ok(pem.split('\n').every(l => l.length <= 64))
  assert.equal(fingerprint(pem), fingerprint(cert))
  assert.equal(fingerprint(pem), fingerprintOf(cert))
  assert.deepEqual(new X509Certificate(pem).raw, raw)
})

/**
 * The plugin applied to a minimal dsh context: the web route it registers is
 * served by a local HTTP server, `connection` answers `state.rejection`, and
 * the pairing lives in a fresh temporary DSH_HOME.
 */
async function plugin(t, { registry, services = {}, timers = false } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const home = tempDir(t, 'idea-home-')
  process.env.DSH_HOME = home
  process.env.HOME = home
  delete process.env.IDEA_DEV_DSH_LOGIN
  const state = { rejection: undefined }
  const logs = []
  let route
  const disposers = []
  const ctx = {
    effect: fn => { disposers.push(fn()) },
    on: () => {},
    get: name => {
      if (name !== 'workspaceRegistry') return services[name]
      if (registry === 'missing') throw new Error('no such service')
      return registry
    },
    logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    webServer: { register: r => { route = r; return () => { route = undefined } } },
    connection: { requestRejection: () => state.rejection },
  }
  apply(ctx)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/idea')
  const server = createServer((req, res) => route.handler(req, res))
  const port = await listen(server)
  t.after(async () => {
    await close(server)
    while (disposers.length) disposers.pop()()
  })
  const call = async (method, path, { json, body, type } = {}) => {
    const headers = {}
    if (json !== undefined || type) headers['content-type'] = type || 'application/json'
    const r = await request(port, { method, path, headers, body: json !== undefined ? JSON.stringify(json) : body })
    try { r.json = JSON.parse(r.text) } catch { /* not JSON */ }
    return r
  }
  return { call, state, logs, home, pairingFile: join(home, 'idea', 'pairing.json') }
}

// dsh's plugin manager, as far as idea uses it.
function pluginManager(bundles, { fail } = {}) {
  const installs = []
  return {
    installs,
    listBundles: async () => bundles,
    installBundle: async (spec, opts) => {
      installs.push([spec, opts])
      if (fail) throw new Error(fail)
    },
  }
}

test('dsh-plugin-subscriptions is installed once, at its pinned version, 10 s after start', async t => {
  const pm = pluginManager([{ name: 'other', installed: true }])
  const h = await plugin(t, { services: { pluginManager: pm }, timers: true })
  t.mock.timers.tick(9_999)
  assert.equal(pm.installs.length, 0)
  t.mock.timers.tick(1)
  await waitFor(() => h.logs.length === 2)
  assert.deepEqual(pm.installs, [['dsh-plugin-subscriptions@0.9.13', { enabled: true, saveExact: true }]])
  assert.match(h.logs[1][1], /restart dsh to load it/)
})

test('an installed or switched-off dsh-plugin-subscriptions is left alone; a failed install is logged', async t => {
  const present = pluginManager([{ name: 'dsh-plugin-subscriptions', installed: true }])
  let h = await plugin(t, { services: { pluginManager: present }, timers: true })
  t.mock.timers.tick(10_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([present.installs, h.logs], [[], []])

  const broken = pluginManager([{ name: 'dsh-plugin-subscriptions', installed: false }], { fail: 'registry down' })
  t.mock.timers.reset()
  h = await plugin(t, { services: { pluginManager: broken }, timers: true })
  t.mock.timers.tick(10_000)
  await waitFor(() => h.logs.some(l => l[0] === 'warn'))
  assert.equal(broken.installs.length, 1)
  assert.deepEqual(h.logs.find(l => l[0] === 'warn').slice(2), ['dsh-plugin-subscriptions', 'registry down'])

  t.mock.timers.reset()
  h = await plugin(t, { services: { pluginManager: { listBundles: async () => [] } }, timers: true })
  t.mock.timers.tick(10_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.logs, [], 'a plugin manager that cannot install is left alone')
})

test('a request dsh rejects gets that status and nothing else', async t => {
  const h = await plugin(t)
  h.state.rejection = 403
  for (const [m, p] of [['GET', '/idea/state'], ['POST', '/idea/pair'], ['GET', '/idea/v1/status'], ['GET', '/idea/git/repos']]) {
    const r = await h.call(m, p, m === 'POST' ? { json: { url: 'machine', code: '1' } } : {})
    assert.equal(r.status, 403, `${m} ${p}`)
    assert.equal(r.text, '')
  }
  h.state.rejection = 401
  assert.equal((await h.call('GET', '/idea/state')).status, 401)
})

test('unpaired: the state says so and every machine route is 409', async t => {
  const h = await plugin(t)
  const s = await h.call('GET', '/idea/state')
  assert.equal(s.status, 200)
  assert.deepEqual(s.json, { paired: false })
  assert.equal(s.headers['cache-control'], 'no-store')
  assert.equal(s.headers['x-content-type-options'], 'nosniff')
  for (const [m, p, json] of [
    ['GET', '/idea/v1/status'], ['POST', '/idea/v1/tasks', { title: 'x' }], ['GET', '/idea/v1/tasks/abc?x=1'],
    ['DELETE', '/idea/v1/devices/0123456789ab'], ['GET', '/idea/view'], ['GET', '/idea/team'],
    ['POST', '/idea/team/stop', { team: 'deadbeef', name: 'alice' }], ['POST', '/idea/team/delete', { team: 'deadbeef' }],
  ]) {
    const r = await h.call(m, p, json ? { json } : {})
    assert.equal(r.status, 409, `${m} ${p}`)
    assert.deepEqual(r.json, { error: 'not paired' })
  }
  assert.deepEqual((await h.call('POST', '/idea/unpair', { json: {} })).json, { paired: false })
})

test('calls outside the allow-list and unknown routes are 404', async t => {
  const h = await plugin(t)
  for (const p of ['/idea/v1/keys', '/idea/v1/tasks/x/../../keys', '/idea/v1/git/repos/o/r/compare/a..b', '/idea/v1/pair', '/idea/v1/devices/zz']) {
    const r = await h.call('GET', p)
    assert.equal(r.status, 404, p)
    assert.deepEqual(r.json, { error: 'unknown call' }, p)
  }
  assert.equal((await h.call('POST', '/idea/v1/status', { json: {} })).status, 404)
  // Dot segments are resolved before the allow-list sees the path.
  for (const p of ['/idea/v1/git/repos/o/../pulls/1/merge', '/idea/v1/git/repos/o/%2e%2e/pulls/1/merge']) {
    assert.deepEqual((await h.call('POST', p, { json: {} })).json, { error: 'unknown call' }, p)
  }
  for (const [m, p] of [['GET', '/idea/nope'], ['GET', '/idea'], ['GET', '/idea/'], ['POST', '/idea/state'], ['GET', '/idea/pair'], ['GET', '/idea/team/stop']]) {
    const r = await h.call(m, p)
    assert.equal(r.status, 404, `${m} ${p}`)
    assert.deepEqual(r.json, { error: 'not found' })
  }
})

test('mutating routes take JSON only, and check their input', async t => {
  const h = await plugin(t)
  assert.equal((await h.call('POST', '/idea/pair', { body: 'url=x', type: 'application/x-www-form-urlencoded' })).status, 415)
  assert.equal((await h.call('POST', '/idea/pair', { body: '{"url":' })).status, 415, 'no content type')
  assert.equal((await h.call('POST', '/idea/pair', { body: '{"url":', type: 'application/json' })).status, 400)
  const big = await h.call('POST', '/idea/pair', { json: { url: 'machine', code: 'x'.repeat(70 * 1024) } }).catch(e => ({ error: e }))
  assert.ok(big.error || big.status === 413, 'a body over 64 KiB is refused')
  let r = await h.call('POST', '/idea/pair', { json: { url: 'http://machine:30443', code: '123456' } })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /https:\/\/<machine>:30443/)
  r = await h.call('POST', '/idea/pair', { json: { url: 'machine:30443', code: '   ' } })
  assert.deepEqual([r.status, r.json.error], [400, 'Enter the setup code.'])
  r = await h.call('POST', '/idea/pair', { json: { code: '123456' } })
  assert.equal(r.status, 400, 'no address is not a lookup of "undefined"')
  r = await h.call('POST', '/idea/pair', { json: { url: 'machine:30443', code: 7 } })
  assert.equal(r.status, 400)
  for (const json of [{ team: 'DEADBEEF' }, { team: 'deadbee' }, { team: 1 }, {}]) {
    r = await h.call('POST', '/idea/team/delete', { json })
    assert.deepEqual([r.status, r.json.error], [400, 'invalid team'], JSON.stringify(json))
  }
})

async function gitWorkspaces(t) {
  const repo = tempDir(t, 'idea-ws-repo-')
  await git(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'a.txt'), 'a\n')
  const plain = tempDir(t, 'idea-ws-plain-')
  return {
    repo,
    registry: { list: () => [{ id: 'w1', title: 'Repo', path: repo }, { id: 'w2', title: '', path: plain }, { id: 3, path: plain + '/missing' }] },
  }
}

test('/idea/git/repos lists only the workspaces that are git repositories', async t => {
  const { repo, registry } = await gitWorkspaces(t)
  const h = await plugin(t, { registry })
  const r = await h.call('GET', '/idea/git/repos')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.local.map(x => [x.id, x.title]), [['w1', 'Repo']])
  assert.equal(r.json.local[0].root, (await git(repo, ['rev-parse', '--show-toplevel'])).out.trim())
})

test('/idea/git/repos is empty without a workspace registry', async t => {
  for (const registry of ['missing', undefined, {}]) {
    const h = await plugin(t, { registry })
    assert.deepEqual((await h.call('GET', '/idea/git/repos')).json, { local: [] })
  }
})

test('/idea/git/local/<id>/... takes a workspace id, never a path', async t => {
  const { registry } = await gitWorkspaces(t)
  const h = await plugin(t, { registry })
  const s = await h.call('GET', '/idea/git/local/w1/state')
  assert.equal(s.status, 200)
  assert.equal(s.json.head.branch, 'main')
  assert.deepEqual(s.json.files.map(f => f.path), ['a.txt'])
  for (const p of ['/idea/git/local/w.1/state', '/idea/git/local/..%2F..%2Fetc/state', '/idea/git/local/%2e%2e/state', '/idea/git/local/w1/other', '/idea/git/local//state']) {
    const r = await h.call('GET', p)
    assert.deepEqual([r.status, r.json.error], [404, 'not found'], p)
  }
  let r = await h.call('GET', '/idea/git/local/nope/state')
  assert.deepEqual([r.status, r.json.error], [404, 'no such workspace'])
  r = await h.call('GET', '/idea/git/local/w2/state')
  assert.equal(r.status, 404)
  assert.match(r.json.error, /is not a git repository/)
  assert.equal((await h.call('POST', '/idea/git/local/w1/state', { json: {} })).status, 405)
  assert.equal((await h.call('GET', '/idea/git/local/w1/act')).status, 405)
  r = await h.call('POST', '/idea/git/local/w1/diff', { json: { kind: 'file', path: '../../etc/passwd', untracked: true } })
  assert.deepEqual([r.status, r.json.error], [400, 'invalid path'])
  r = await h.call('POST', '/idea/git/local/w1/diff', { json: { kind: 'file', path: 'a.txt', untracked: true } })
  assert.match(r.json.diff, /^new file: a\.txt\n/)
  assert.equal((await h.call('POST', '/idea/git/local/w1/diff', { body: '{}' })).status, 415)
  r = await h.call('GET', '/idea/git/local/w1/log?ref=--output=/tmp/x')
  assert.deepEqual([r.status, r.json.error], [400, 'invalid branch'])
  r = await h.call('POST', '/idea/git/local/w1/act', { json: { op: 'rm -rf' } })
  assert.deepEqual([r.status, r.json.error], [400, 'unknown action'])
})

/**
 * A stand-in for the idea machine's API over HTTPS with `pair` (code
 * 123456), echo endpoints, device revocation, the dsh lookup and the VM list.
 */
async function fakeMachine(t, pair, { dshPort, workerPort } = {}) {
  const seen = []
  const server = createHttpsServer({ cert: pair.cert, key: pair.key }, (req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const send = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      const url = new URL(req.url, 'https://x')
      if (url.pathname === '/api/v1/pair') {
        const input = JSON.parse(body)
        if (input.code !== '123456') { send(401, { error: 'wrong code' }); return }
        send(200, { token: 'tok-device-secret', id: '0123456789ab', host: 'idea' })
        return
      }
      if (req.headers.authorization !== 'Bearer tok-device-secret') { send(401, { error: 'no token' }); return }
      if (url.pathname === '/api/v1/dsh') {
        if (!dshPort) { send(503, { error: 'the agent dsh is not up' }); return }
        send(200, { login: '/login?once=1', port: url.searchParams.get('vm') ? workerPort || dshPort : dshPort, authority: 'idea-dsh.idea:8080' })
        return
      }
      if (url.pathname === '/api/v1/vms') {
        send(200, { workers: [{ name: 'idea-worker-0', ready: true }, { name: 'idea-worker-1', ready: false }, { name: 'evil host', ready: true }, null] })
        return
      }
      if (url.pathname === '/api/v1/tasks/teapot') { res.writeHead(418, { 'content-type': 'text/plain' }).end('short and stout'); return }
      if (req.method === 'DELETE') { res.writeHead(204).end(); return }
      send(200, { method: req.method, url: req.url, body })
    })
  })
  const port = await listen(server)
  t.after(() => close(server))
  return { port, seen, url: `https://127.0.0.1:${port}` }
}

async function paired(h, machine) {
  const r = await h.call('POST', '/idea/pair', { json: { url: machine.url, code: ' 123456 ' } })
  assert.equal(r.status, 200, r.text)
  return r
}

test('pairing pins the certificate the machine presented and keeps the token out of the page', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const machine = await fakeMachine(t, pair)
  const h = await plugin(t)
  let r = await h.call('POST', '/idea/pair', { json: { url: machine.url, code: '000000' } })
  assert.deepEqual([r.status, r.json.error], [401, 'Wrong setup code.'])
  await assert.rejects(stat(h.pairingFile), { code: 'ENOENT' })

  r = await paired(h, machine)
  assert.deepEqual(r.json, { paired: true, url: machine.url, host: 'idea', device: '0123456789ab', fingerprint: fingerprintOf(pair.cert) })
  assert.ok(!r.text.includes('tok-device-secret'))
  assert.deepEqual(JSON.parse(machine.seen.at(-1).body), { code: '123456', device: `dsh on ${hostname()}`.slice(0, 64) })

  const saved = JSON.parse(await readFile(h.pairingFile, 'utf8'))
  assert.equal(saved.token, 'tok-device-secret')
  assert.equal(fingerprintOf(saved.cert), fingerprintOf(pair.cert))
  assert.equal((await stat(h.pairingFile)).mode & 0o777, 0o600)
  assert.equal((await stat(join(h.home, 'idea'))).mode & 0o777, 0o700)

  const s = await h.call('GET', '/idea/state')
  assert.equal(s.json.paired, true)
  assert.equal(s.json.fingerprint, fingerprintOf(pair.cert))
  assert.ok(!s.text.includes('tok-device-secret'))
})

test('pairing with a machine that is not there is a 502', { skip: noOpenssl }, async t => {
  const gone = createServer()
  const port = await listen(gone)
  await close(gone)
  const h = await plugin(t)
  const r = await h.call('POST', '/idea/pair', { json: { url: `https://127.0.0.1:${port}`, code: '123456' } })
  assert.equal(r.status, 502)
  assert.match(r.json.error, /^Could not reach the machine/)
})

test('allowed calls are forwarded with the device token, over the pinned connection', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const machine = await fakeMachine(t, pair)
  const h = await plugin(t)
  await paired(h, machine)
  let r = await h.call('GET', '/idea/v1/status')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { method: 'GET', url: '/api/v1/status', body: '' })
  assert.equal(machine.seen.at(-1).auth, 'Bearer tok-device-secret')
  assert.equal(r.headers['cache-control'], 'no-store')
  r = await h.call('GET', '/idea/v1/tasks/abc-1?full=1')
  assert.equal(r.json.url, '/api/v1/tasks/abc-1?full=1')
  r = await h.call('POST', '/idea/v1/tasks', { json: { title: 'build it' } })
  assert.deepEqual(JSON.parse(r.json.body), { title: 'build it' })
  assert.equal((await h.call('POST', '/idea/v1/tasks', { body: 'title=x', type: 'text/plain' })).status, 415)
  r = await h.call('GET', '/idea/v1/tasks/teapot')
  assert.deepEqual([r.status, r.headers['content-type'], r.text], [418, 'text/plain', 'short and stout'], 'the machine answer passes through')
  assert.equal((await h.call('DELETE', '/idea/v1/devices/0123456789ab')).status, 204)
})

test('a machine presenting another certificate is refused before the token is sent', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const impostor = await fakeMachine(t, selfSigned('impostor'))
  const h = await plugin(t)
  await mkdir(join(h.home, 'idea'), { recursive: true })
  await writeFile(h.pairingFile, JSON.stringify({ url: impostor.url, token: 'tok-device-secret', id: '0123456789ab', host: 'idea', cert: pair.cert }))
  const r = await h.call('GET', '/idea/v1/status')
  assert.equal(r.status, 502)
  assert.equal(r.json.offline, true)
  assert.match(r.json.error, /different certificate than the one paired/)
  assert.equal(impostor.seen.length, 0)
})

test('unpairing revokes the device on the machine and forgets the pairing, even offline', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const machine = await fakeMachine(t, pair)
  const h = await plugin(t)
  await paired(h, machine)
  let r = await h.call('POST', '/idea/unpair', { json: {} })
  assert.deepEqual(r.json, { paired: false })
  assert.deepEqual([machine.seen.at(-1).method, machine.seen.at(-1).url, machine.seen.at(-1).auth], ['DELETE', '/api/v1/devices/0123456789ab', 'Bearer tok-device-secret'])
  await assert.rejects(stat(h.pairingFile), { code: 'ENOENT' })
  assert.deepEqual((await h.call('GET', '/idea/state')).json, { paired: false })

  await paired(h, machine)
  const saved = JSON.parse(await readFile(h.pairingFile, 'utf8'))
  await writeFile(h.pairingFile, JSON.stringify({ ...saved, url: 'https://127.0.0.1:1' }))
  r = await h.call('POST', '/idea/unpair', { json: {} })
  assert.deepEqual(r.json, { paired: false })
  await assert.rejects(stat(h.pairingFile), { code: 'ENOENT' })
})

/**
 * An agent dsh of the machine (same certificate, its own port): /login sets
 * a session, the team owner routes answer `answers[path]` and are recorded.
 */
async function agentDsh(t, pair, answers = {}) {
  const owner = []
  const server = createHttpsServer({ cert: pair.cert, key: pair.key }, (req, res) => {
    if (req.url.startsWith('/login')) { res.writeHead(302, { 'set-cookie': 'sid=1; Path=/', location: '/' }).end(); return }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', c => { body += c })
    req.on('end', () => {
      const answer = answers[req.url]
      if (!answer) { res.writeHead(404).end(); return }
      owner.push({ path: req.url, body: JSON.parse(body) })
      res.writeHead(answer[0], { 'content-type': 'application/json' }).end(JSON.stringify(answer[1]))
    })
  })
  const port = await listen(server)
  t.after(() => close(server))
  return { port, owner }
}

test('/idea/view frames the machine dsh through a local proxy; /idea/team asks only ready workers', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const { port: dshPort } = await agentDsh(t, pair)
  const machine = await fakeMachine(t, pair, { dshPort })
  const h = await plugin(t)
  await paired(h, machine)

  let r = await h.call('GET', '/idea/view')
  assert.equal(r.status, 200, r.text)
  const src = new URL(r.json.src)
  assert.deepEqual([src.protocol, src.hostname, src.pathname], ['http:', '127.0.0.1', '/__idea/enter'])
  assert.equal((await request(Number(src.port), { path: src.pathname + src.search })).status, 302)
  assert.equal((await h.call('GET', '/idea/view?vm=idea-dsh')).status, 200)
  for (const vm of ['evil', 'idea-worker-', 'idea-worker-1234', '../x']) {
    r = await h.call('GET', '/idea/view?vm=' + encodeURIComponent(vm))
    assert.deepEqual([r.status, r.json.error], [400, 'unknown VM'], vm)
  }

  r = await h.call('GET', '/idea/team')
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.json.teams, [])
  const asked = machine.seen.filter(s => s.url.startsWith('/api/v1/dsh')).map(s => s.url)
  assert.ok(asked.includes('/api/v1/dsh?vm=idea-worker-0'))
  assert.ok(!asked.some(u => u.includes('idea-worker-1') || u.includes('evil')), asked.join(' '))
})

test('/idea/view is a 502 when the machine has no dsh to show', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const machine = await fakeMachine(t, pair)
  const h = await plugin(t)
  await paired(h, machine)
  const r = await h.call('GET', '/idea/view')
  assert.equal(r.status, 502)
  assert.equal(r.json.error, "could not reach the machine's dsh: the agent dsh is not up")
})

test('the team controls ask the lead dsh, and a delete reaches every ready worker', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const lead = await agentDsh(t, pair, {
    '/idea-team/owner/stop': [200, { ok: true }],
    '/idea-team/owner/delete': [200, { ok: true }],
  })
  const worker = await agentDsh(t, pair, { '/idea-team/owner/delete': [500, { error: 'disk full' }] })
  const machine = await fakeMachine(t, pair, { dshPort: lead.port, workerPort: worker.port })
  const h = await plugin(t)
  await paired(h, machine)

  let r = await h.call('POST', '/idea/team/stop', { json: { team: 'deadbeef', name: 'alice' } })
  assert.deepEqual([r.status, r.json], [200, { ok: true }])
  assert.deepEqual(lead.owner, [{ path: '/idea-team/owner/stop', body: { team: 'deadbeef', name: 'alice' } }])
  for (const name of ['Alice', '-x', 'a'.repeat(33), 7]) {
    r = await h.call('POST', '/idea/team/stop', { json: { team: 'deadbeef', name } })
    assert.deepEqual([r.status, r.json.error], [400, 'invalid name'], String(name))
  }
  assert.equal(lead.owner.length, 1)

  r = await h.call('POST', '/idea/team/delete', { json: { team: 'deadbeef' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, errors: [{ vm: 'idea-worker-0', error: 'disk full' }] })
  assert.deepEqual(lead.owner.at(-1), { path: '/idea-team/owner/delete', body: { team: 'deadbeef' } })
  assert.deepEqual(worker.owner, [{ path: '/idea-team/owner/delete', body: { team: 'deadbeef' } }])
})

test('a team control the lead refuses keeps its status', { skip: noOpenssl }, async t => {
  const pair = selfSigned('machine')
  const lead = await agentDsh(t, pair, { '/idea-team/owner/stop': [404, { error: 'no such member' }], '/idea-team/owner/delete': [500, { error: 'broken' }] })
  const machine = await fakeMachine(t, pair, { dshPort: lead.port })
  const h = await plugin(t)
  await paired(h, machine)
  let r = await h.call('POST', '/idea/team/stop', { json: { team: 'deadbeef', name: 'bob' } })
  assert.deepEqual([r.status, r.json.error], [404, 'no such member'])
  r = await h.call('POST', '/idea/team/delete', { json: { team: 'deadbeef' } })
  assert.deepEqual([r.status, r.json.error], [502, 'broken'], 'a machine failure is a bad gateway here')
})
