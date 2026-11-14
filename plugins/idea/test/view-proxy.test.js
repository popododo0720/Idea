import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createViewProxy } from '../lib/view-proxy.js'
import { close, hasOpenssl, listen, request, selfSigned } from './helpers.js'

const AUTHORITY = 'idea-dsh.idea.svc:8080'

/**
 * A stand-in for the machine's dsh: GET /login hands out a session cookie,
 * every other request needs a valid one and is echoed back as JSON, and a
 * WebSocket upgrade answers 101 and echoes bytes.
 */
function fakeDsh({ tls } = {}) {
  const state = { logins: 0, sessions: new Set(), seen: [], upgrades: [], loginCookie: true }
  const sid = h => /(?:^|; )sid=([^;]+)/.exec(h.cookie || '')?.[1]
  const onRequest = (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/login') {
      state.logins++
      if (!state.loginCookie) { res.writeHead(403).end(); return }
      const s = 's' + state.logins
      state.sessions.add(s)
      res.writeHead(302, { 'set-cookie': [`sid=${s}; Path=/; HttpOnly; SameSite=Strict`], location: '/' }).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', c => { body += c })
    req.on('end', () => {
      state.seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (!state.sessions.has(sid(req.headers))) { res.writeHead(401).end('login'); return }
      if (url.pathname.startsWith('/api/')) {
        const rpc = JSON.parse(body)
        const value = rpc.method === 'ws/fail' ? { ok: false, error: { code: 'nope' } } : { ok: true, value: { echo: rpc.payload.args } }
        res.writeHead(rpc.method === 'ws/http500' ? 500 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: value }))
        return
      }
      const headers = { 'content-type': 'application/json', 'x-up': '1' }
      if (url.pathname === '/prefs') headers['set-cookie'] = 'pref=dark; Path=/'
      res.writeHead(200, headers).end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
    })
  }
  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }, onRequest) : createHttpServer(onRequest)
  server.on('upgrade', (req, socket) => {
    state.upgrades.push({ url: req.url, headers: req.headers })
    if (!state.sessions.has(sid(req.headers))) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', c => socket.write('echo:' + c))
  })
  return { server, state, expire: () => state.sessions.clear() }
}

async function setup(t, { tls, cert } = {}) {
  const dsh = fakeDsh({ tls })
  const port = await listen(dsh.server)
  t.after(() => close(dsh.server))
  const logs = []
  const proxy = createViewProxy({
    upstream: async () => ({ url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`, login: '/login?token=one-time', authority: AUTHORITY, cert }),
    log: m => logs.push(m),
  })
  t.after(() => proxy.close())
  const enter = new URL(await proxy.enterUrl())
  return { dsh, proxy, enter, port: Number(enter.port), logs }
}

// Enter through the ticket and return the view cookie the browser now has.
async function enterCookie(port, enter) {
  const r = await request(port, { path: enter.pathname + enter.search })
  assert.equal(r.status, 302)
  return r.headers['set-cookie'][0].split(';')[0]
}

test('the one-time ticket lets a browser in once and sets an HttpOnly, SameSite=Strict view cookie', async t => {
  const { dsh, enter, port } = await setup(t)
  assert.equal(enter.hostname, '127.0.0.1')
  assert.equal(enter.pathname, '/__idea/enter')
  assert.equal(dsh.state.logins, 1, 'enterUrl signs in to the machine first')
  const first = await request(port, { path: enter.pathname + enter.search })
  assert.equal(first.status, 302)
  assert.equal(first.headers.location, '/')
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.match(first.headers['set-cookie'][0], /^idea_view=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/)
  const again = await request(port, { path: enter.pathname + enter.search })
  assert.equal(again.status, 403, 'a ticket works once')
  assert.equal((await request(port, { path: '/__idea/enter?t=guess' })).status, 403)
  assert.equal((await request(port, { path: '/__idea/enter' })).status, 403)
})

test('a ticket presented under another Host is refused and used up', async t => {
  const { proxy, enter, port } = await setup(t)
  const r = await request(port, { path: enter.pathname + enter.search, headers: { host: `localhost:${port}` } })
  assert.equal(r.status, 403)
  assert.equal((await request(port, { path: enter.pathname + enter.search })).status, 403)
  const next = new URL(await proxy.enterUrl())
  assert.notEqual(next.search, enter.search, 'each call hands out a new ticket')
  assert.equal((await request(port, { path: next.pathname + next.search })).status, 302)
})

test('only its own Host and the view cookie or its own origin get through', async t => {
  const { dsh, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  const self = `http://127.0.0.1:${port}`
  const cases = [
    // [what, method, headers, expected status]
    ['a plain read with no Origin (navigation, asset)', 'GET', {}, 200],
    ['a write with no cookie and no Origin', 'POST', {}, 403],
    ['a write from another site', 'POST', { origin: 'https://evil.example' }, 403],
    ['a read from another site', 'GET', { origin: 'https://evil.example' }, 403],
    ['a wrong view cookie from another site', 'POST', { cookie: 'idea_view=' + 'a'.repeat(64), origin: 'https://evil.example' }, 403],
    ['a write from its own origin', 'POST', { origin: self }, 200],
    ['a write with the view cookie', 'POST', { cookie }, 200],
    ['the view cookie under another Host (DNS rebinding)', 'GET', { cookie, host: `rebind.example:${port}` }, 403],
    ['the view cookie under localhost', 'GET', { cookie, host: `localhost:${port}` }, 403],
  ]
  for (const [what, method, headers, want] of cases) {
    const before = dsh.state.seen.length
    const r = await request(port, { method, path: '/x', headers, body: method === 'POST' ? '{}' : undefined })
    assert.equal(r.status, want, what)
    assert.equal(dsh.state.seen.length - before, want === 200 ? 1 : 0, `${what}: reached the machine`)
  }
})

test('requests reach the machine with its Host, Origin and Referer and the proxy\'s own login', async t => {
  const { dsh, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  const r = await request(port, {
    method: 'POST', path: '/api/thing?x=1',
    headers: { cookie: `${cookie}; browser=1`, origin: `http://127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/page?y=2`, 'content-type': 'application/json', 'proxy-authorization': 'Basic eA==' },
    body: JSON.stringify({ method: 'thing', payload: { args: { a: 1 } } }),
  })
  assert.equal(r.status, 200)
  const up = dsh.state.seen.at(-1)
  assert.equal(up.method, 'POST')
  assert.equal(up.url, '/api/thing?x=1')
  assert.equal(up.headers.host, AUTHORITY)
  assert.equal(up.headers.origin, `http://${AUTHORITY}`)
  assert.equal(up.headers.referer, `http://${AUTHORITY}/page?y=2`)
  assert.equal(up.headers.cookie, 'sid=s1', 'only the machine session, never the browser cookies')
  assert.equal(up.headers['proxy-authorization'], undefined)
  assert.deepEqual(JSON.parse(up.body), { method: 'thing', payload: { args: { a: 1 } } })
})

test('cookies the machine sets stay in the proxy and are sent on later requests', async t => {
  const { dsh, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  const r = await request(port, { path: '/prefs', headers: { cookie } })
  assert.equal(r.status, 200)
  assert.equal(r.headers['set-cookie'], undefined, 'the browser never sees a machine cookie')
  assert.equal(r.headers['x-up'], '1', 'other response headers pass through')
  assert.equal(JSON.parse(r.text).headers.host, AUTHORITY)
  await request(port, { path: '/next', headers: { cookie } })
  assert.equal(dsh.state.seen.at(-1).headers.cookie, 'sid=s1; pref=dark')
})

test('an expired machine session is renewed once for reads and JSON calls', async t => {
  const { dsh, proxy, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  dsh.expire()
  const r = await request(port, { path: '/after', headers: { cookie } })
  assert.equal(r.status, 200)
  assert.equal(dsh.state.logins, 2)
  assert.equal(JSON.parse(r.text).headers.cookie, 'sid=s2')
  dsh.expire()
  const j = await proxy.json('GET', '/status')
  assert.equal(j.status, 200)
  assert.equal(dsh.state.logins, 3)
  assert.equal(JSON.parse(j.text).method, 'GET')
  // A write is not replayed: the machine's 401 reaches the browser.
  dsh.expire()
  const w = await request(port, { method: 'POST', path: '/write', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(w.status, 401)
  assert.equal(dsh.state.logins, 3)
})

test('json and rpc talk to the machine with the proxy login; errors carry no arguments', async t => {
  const { dsh, proxy } = await setup(t)
  const j = await proxy.json('PUT', '/idea-sync/records', { records: { a: 1 } })
  const echoed = JSON.parse(j.text)
  assert.equal(echoed.method, 'PUT')
  assert.equal(echoed.headers.host, AUTHORITY)
  assert.equal(echoed.headers.origin, `http://${AUTHORITY}`)
  assert.equal(echoed.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(echoed.body), { records: { a: 1 } })
  assert.deepEqual(await proxy.rpc('credentials/set', { ref: 'K', value: 'v' }), { echo: { ref: 'K', value: 'v' } })
  const call = JSON.parse(dsh.state.seen.at(-1).body)
  assert.equal(dsh.state.seen.at(-1).url, '/api/credentials/set')
  assert.equal(call.type, 'client-request')
  assert.match(call.rpcId, /^idea-[0-9a-f]{12}$/)
  assert.equal(call.method, 'credentials/set')
  const secret = 'sk-do-not-print'
  await assert.rejects(proxy.rpc('ws/fail', { value: secret }), e => e.message === 'idea: machine dsh ws/fail: nope')
  await assert.rejects(proxy.rpc('ws/http500', { value: secret }), e => e.message === 'idea: machine dsh ws/http500: HTTP 500')
})

test('a failed machine login is a 502, and reset() signs in again', async t => {
  const { dsh, proxy, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  proxy.reset()
  dsh.state.loginCookie = false
  const r = await request(port, { path: '/x', headers: { cookie } })
  assert.equal(r.status, 502)
  assert.match(r.text, /login to the machine's dsh failed \(HTTP 403\)/)
  await assert.rejects(proxy.json('GET', '/x'), /login to the machine's dsh failed/)
  dsh.state.loginCookie = true
  assert.equal((await request(port, { path: '/x', headers: { cookie } })).status, 200)
})

test('a machine that is down is a 502, not a crash', async t => {
  const { dsh, proxy, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  proxy.reset()
  await close(dsh.server)
  const r = await request(port, { path: '/x', headers: { cookie } })
  assert.equal(r.status, 502)
})

// Open a WebSocket-style upgrade through the proxy; resolves the response or the piped socket.
function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/ws?s=1', agent: false, headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }))
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('error', reject)
    req.end()
  })
}

test('WebSocket upgrades are piped to the machine with its Host and Origin', async t => {
  const { dsh, enter, port } = await setup(t)
  const cookie = await enterCookie(port, enter)
  const wsKey = Buffer.from('the sample nonce').toString('base64')
  const { status, socket } = await upgrade(port, { origin: `http://127.0.0.1:${port}`, 'sec-websocket-key': wsKey })
  assert.equal(status, 101)
  socket.write('ping')
  const back = await new Promise(resolve => socket.once('data', c => resolve(String(c))))
  assert.equal(back, 'echo:ping')
  socket.destroy()
  const up = dsh.state.upgrades.at(-1)
  assert.equal(up.url, '/ws?s=1')
  assert.equal(up.headers.host, AUTHORITY)
  assert.equal(up.headers.origin, `http://${AUTHORITY}`)
  assert.equal(up.headers.cookie, 'sid=s1')
  assert.equal(up.headers.upgrade, 'websocket')
  assert.equal(up.headers['sec-websocket-key'], wsKey)
  // With the view cookie and no Origin is also fine; another site or no proof is not.
  const withCookie = await upgrade(port, { cookie })
  assert.equal(withCookie.status, 101)
  withCookie.socket.destroy()
  const before = dsh.state.upgrades.length
  assert.equal((await upgrade(port, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await upgrade(port, {})).status, 403, 'an upgrade needs the cookie or its own origin')
  assert.equal(dsh.state.upgrades.length, before)
})

test('an https machine is only used through its pinned certificate', { skip: !hasOpenssl() && 'openssl is not installed' }, async t => {
  const machine = selfSigned('machine')
  const { dsh, enter, port } = await setup(t, { tls: machine, cert: machine.cert })
  const cookie = await enterCookie(port, enter)
  const r = await request(port, { path: '/over-tls', headers: { cookie } })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(r.text).headers.host, AUTHORITY)
  assert.equal(dsh.state.logins, 1)

  // The same machine, but the proxy was paired with another certificate.
  const other = selfSigned('impostor')
  const dsh2 = fakeDsh({ tls: machine })
  const port2 = await listen(dsh2.server)
  t.after(() => close(dsh2.server))
  const wrong = createViewProxy({ upstream: async () => ({ url: `https://127.0.0.1:${port2}`, login: '/login', cert: other.cert }) })
  t.after(() => wrong.close())
  await assert.rejects(wrong.enterUrl(), /different certificate than the one paired/)
  const none = createViewProxy({ upstream: async () => ({ url: `https://127.0.0.1:${port2}`, login: '/login' }) })
  t.after(() => none.close())
  await assert.rejects(none.json('GET', '/x'), /no pinned certificate/)
  assert.equal(dsh2.state.logins, 0, 'nothing was sent to a machine that did not prove its certificate')
})
