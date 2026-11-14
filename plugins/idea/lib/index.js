// idea: the DeepSeek Harness plugin for an idea machine (host half).
//
// The idea machine runs the agents; this plugin is how a person sees and
// steers them from their own dsh (desktop app or `dsh web`). The browser
// half (client.js) draws the panel; this half holds the pairing and forwards
// the panel's calls to the machine's API, so the token never reaches the page.
//
//   panel ──/idea/*──▶ this plugin ──HTTPS, pinned certificate──▶ idea /api/v1
//
// Every route first asks dsh's `connection` service whether the caller is the
// signed-in owner of this dsh (its Host/Origin fence and login cookie), the
// same check dsh's own routes use. Mutating routes take JSON only.
//
// Pairing is stored in $DSH_HOME/idea/pairing.json (mode 600): the machine's
// address, its certificate (pinned) and the device token.

import { X509Certificate, createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createViewProxy } from './view-proxy.js'
import { pinnedSocket, portOf } from './tls-pin.js'
import { createModelSync } from './model-sync.js'
import { createSubscriptionsSync } from './subscriptions-sync.js'
import { teamView } from './team-view.js'

export const name = 'idea'
export const inject = ['webServer', 'connection']

const PREFIX = '/idea'
// Subscription sign-ins (Claude, ChatGPT/Codex, Grok, Copilot, Antigravity)
// come from this plugin, installed alongside idea at an exact version.
const SUBSCRIPTIONS = 'dsh-plugin-subscriptions'
const SUBSCRIPTIONS_VERSION = '0.9.13'
const MAX_BODY = 64 * 1024
const TIMEOUT_MS = 20_000

function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'idea')
}
const pairingFile = () => join(stateDir(), 'pairing.json')

async function loadPairing() {
  try {
    const p = JSON.parse(await readFile(pairingFile(), 'utf8'))
    if (typeof p.url === 'string' && typeof p.token === 'string' && typeof p.cert === 'string') return p
  } catch { /* not paired */ }
  return undefined
}

async function savePairing(p) {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 })
  const tmp = pairingFile() + '.tmp'
  await writeFile(tmp, JSON.stringify(p, null, 2), { mode: 0o600 })
  await rename(tmp, pairingFile())
}

/** https://host[:port] only; the API lives under /api/v1 on it. */
function normalizeUrl(raw) {
  let u
  try { u = new URL(String(raw).trim().includes('://') ? String(raw).trim() : 'https://' + String(raw).trim()) } catch { return undefined }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined
  return `https://${u.host}`
}

function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256
}

/**
 * One HTTPS call to the machine. With `pin`, the connection is only used
 * once the machine has shown exactly the paired certificate (tls-pin.js).
 * Without it (pairing), any certificate is accepted and returned, to be
 * pinned from then on.
 */
async function call(base, method, path, { body, token, pin } = {}) {
  const url = new URL(path, base)
  const socket = pin ? await pinnedSocket({ host: url.hostname, port: portOf(url), pin }) : undefined
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json' }
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = String(data.length) }
    if (token) headers.authorization = `Bearer ${token}`
    // With createConnection and no agent, Node uses the already verified socket.
    const tls = socket ? { createConnection: () => socket } : { agent: false, rejectUnauthorized: false }
    const req = httpsRequest(url, { method, headers, timeout: TIMEOUT_MS, ...tls }, res => {
      const chunks = []
      let size = 0
      res.on('data', c => {
        size += c.length
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('idea: response too large')); return }
        chunks.push(c)
      })
      res.on('end', () => {
        const peer = res.socket && typeof res.socket.getPeerCertificate === 'function'
          ? res.socket.getPeerCertificate(false) : undefined
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), peerRaw: peer && peer.raw })
      })
    })
    req.on('timeout', () => req.destroy(new Error('idea: the machine did not answer')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '')
    if (!type.startsWith('application/json')) { reject(Object.assign(new Error('JSON only'), { status: 415 })); return }
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (size === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function toPem(raw) {
  const b64 = raw.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
}

/** Calls the panel may make, forwarded to /api/v1 (method, path pattern). */
const FORWARD = [
  ['GET', /^\/status$/],
  ['POST', /^\/projects$/],
  ['POST', /^\/tasks$/],
  ['GET', /^\/tasks\/[a-z0-9-]{1,120}$/],
  ['POST', /^\/tasks\/[a-z0-9-]{1,120}\/(retry|cancel)$/],
  ['PUT', /^\/keys$/],
  ['GET', /^\/devices$/],
  ['GET', /^\/vms$/],
  ['DELETE', /^\/devices\/[0-9a-f]{12}$/],
]

/** A VM name the panel may ask for: "" is the main dsh, or a worker VM. */
const VM = /^(idea-worker-\d{1,3})?$/

export function apply(ctx) {
  // A dsh of the machine (vm "" is the main one, else a worker VM), framed by
  // the panel through a local proxy. Each has its own proxy and login.
  const makeView = vm => createViewProxy({
    upstream: async () => {
      if (process.env.IDEA_DEV_DSH_LOGIN) {
        // Development only: a dsh web started by hand, no pairing involved.
        const login = new URL(process.env.IDEA_DEV_DSH_LOGIN)
        return { url: login.origin, login: login.pathname + login.search }
      }
      const p = await loadPairing()
      if (!p) throw new Error('not paired')
      const r = await call(p.url, 'GET', `/api/v1/dsh${vm ? `?vm=${vm}` : ''}`, { token: p.token, pin: p.cert })
      let out = {}
      try { out = JSON.parse(r.body.toString('utf8') || '{}') } catch { /* not JSON */ }
      if (r.status !== 200 || typeof out.login !== 'string' || !Number.isInteger(out.port)) {
        throw new Error(out.error || `the machine answered HTTP ${r.status}`)
      }
      // The agent dsh listens on its own port of the same machine, answers to
      // its in-cluster name, and serves the same certificate as the API.
      const base = new URL(p.url)
      base.port = String(out.port)
      return { url: base.origin, authority: out.authority, login: out.login, cert: p.cert }
    },
  })
  // The main dsh: what the panel opens first, and where models are sent.
  const view = makeView('')
  const views = new Map([['', view]])
  const viewOf = vm => {
    let v = views.get(vm)
    if (!v) { v = makeView(vm); views.set(vm, v) }
    return v
  }
  const resetViews = () => { for (const v of views.values()) v.reset() }
  ctx.effect(() => () => { for (const v of views.values()) v.close() }, 'idea: view proxies')

  // Models and keys set up in this dsh follow to the machine's dsh.
  const models = createModelSync({
    ctx,
    rpc: (method, args) => view.rpc(method, args),
    json: (method, path, value) => view.json(method, path, value),
    paired: async () => Boolean(process.env.IDEA_DEV_DSH_LOGIN) || (await loadPairing()) !== undefined,
  })
  models.schedule()

  // Install dsh-plugin-subscriptions with idea, once, through dsh's own plugin
  // manager (pnpm checks the registry integrity). A bundle the person already
  // has, or switched off, is left as it is. It loads after the next restart.
  const ensureSubscriptions = async () => {
    const pm = ctx.get('pluginManager')
    if (!pm || typeof pm.listBundles !== 'function' || typeof pm.installBundle !== 'function') return
    const present = (await pm.listBundles()).find(b => b.name === SUBSCRIPTIONS)
    if (present && present.installed) return
    ctx.logger.info('idea: installing %s@%s', SUBSCRIPTIONS, SUBSCRIPTIONS_VERSION)
    await pm.installBundle(`${SUBSCRIPTIONS}@${SUBSCRIPTIONS_VERSION}`, { enabled: true, saveExact: true })
    ctx.logger.info('idea: %s installed; restart dsh to load it', SUBSCRIPTIONS)
  }
  const installTimer = setTimeout(() => {
    ensureSubscriptions().catch(e => ctx.logger.warn('idea: could not install %s: %s', SUBSCRIPTIONS, e && e.message))
  }, 10_000)
  ctx.effect(() => () => clearTimeout(installTimer), 'idea: subscriptions install')

  // dsh-plugin-subscriptions sign-ins (its own file) stay in step with the machine.
  const subscriptions = createSubscriptionsSync({
    ctx,
    json: (method, path, value) => view.json(method, path, value),
    paired: async () => Boolean(process.env.IDEA_DEV_DSH_LOGIN) || (await loadPairing()) !== undefined,
  })

  // Worker VMs that are up, for the Team tab.
  const workerVms = async () => {
    if (process.env.IDEA_DEV_DSH_LOGIN) return []
    const p = await loadPairing()
    if (!p) return []
    const r = await call(p.url, 'GET', '/api/v1/vms', { token: p.token, pin: p.cert })
    if (r.status !== 200) throw new Error(`the machine answered HTTP ${r.status}`)
    const v = JSON.parse(r.body.toString('utf8') || '{}')
    return (v.workers || []).filter(w => w && w.ready && typeof w.name === 'string' && w.name && VM.test(w.name)).map(w => w.name)
  }

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://local')
    const sub = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method || 'GET'

    if (sub === '/state' && method === 'GET') {
      if (process.env.IDEA_DEV_DSH_LOGIN) { sendJson(res, 200, { paired: true, dev: true, url: new URL(process.env.IDEA_DEV_DSH_LOGIN).origin }); return }
      const p = await loadPairing()
      sendJson(res, 200, p
        ? { paired: true, url: p.url, host: p.host, device: p.id, fingerprint: fingerprint(p.cert), pairedAt: p.pairedAt }
        : { paired: false })
      return
    }

    if (sub === '/view' && method === 'GET') {
      if (!process.env.IDEA_DEV_DSH_LOGIN && !(await loadPairing())) { sendJson(res, 409, { error: 'not paired' }); return }
      let vm = url.searchParams.get('vm') || ''
      if (vm === 'idea-dsh') vm = ''
      if (!VM.test(vm) || (vm && process.env.IDEA_DEV_DSH_LOGIN)) { sendJson(res, 400, { error: 'unknown VM' }); return }
      try {
        sendJson(res, 200, { src: await viewOf(vm).enterUrl() })
      } catch (e) {
        sendJson(res, 502, { error: `could not reach the machine's dsh: ${e.message}` })
      }
      return
    }

    if (sub === '/team' && method === 'GET') {
      if (!process.env.IDEA_DEV_DSH_LOGIN && !(await loadPairing())) { sendJson(res, 409, { error: 'not paired' }); return }
      let workers
      try { workers = await workerVms() } catch (e) { sendJson(res, 502, { error: `Could not reach the machine: ${e.message}`, offline: true }); return }
      sendJson(res, 200, await teamView({ workers, viewOf }))
      return
    }

    if (sub === '/pair' && method === 'POST') {
      const input = await readJson(req)
      const base = normalizeUrl(input.url)
      const code = typeof input.code === 'string' ? input.code.trim() : ''
      if (!base) { sendJson(res, 400, { error: 'The address must look like https://<machine>:30443' }); return }
      if (!code) { sendJson(res, 400, { error: 'Enter the setup code.' }); return }
      let r
      try {
        r = await call(base, 'POST', '/api/v1/pair', { body: { code, device: `dsh on ${hostname()}`.slice(0, 64) } })
      } catch (e) {
        sendJson(res, 502, { error: `Could not reach the machine: ${e.message}` }); return
      }
      let out = {}
      try { out = JSON.parse(r.body.toString('utf8')) } catch { /* not JSON */ }
      if (r.status !== 200 || typeof out.token !== 'string' || !r.peerRaw) {
        const msg = r.status === 401 ? 'Wrong setup code.' : (out.error || `The machine answered HTTP ${r.status}.`)
        sendJson(res, r.status === 401 ? 401 : 502, { error: msg }); return
      }
      const cert = toPem(r.peerRaw)
      await savePairing({ url: base, token: out.token, id: out.id, host: out.host, cert, pairedAt: new Date().toISOString() })
      resetViews()
      models.schedule()
      subscriptions.reset()
      subscriptions.now()
      sendJson(res, 200, { paired: true, url: base, host: out.host, device: out.id, fingerprint: fingerprint(cert) })
      return
    }

    if (sub === '/unpair' && method === 'POST') {
      await readJson(req)
      const p = await loadPairing()
      if (p) {
        // Revoke on the machine when it answers; forget locally either way.
        try { await call(p.url, 'DELETE', `/api/v1/devices/${p.id}`, { token: p.token, pin: p.cert }) } catch { /* offline */ }
        await rm(pairingFile(), { force: true })
      }
      resetViews()
      models.reset()
      subscriptions.reset()
      sendJson(res, 200, { paired: false })
      return
    }

    if (sub.startsWith('/v1/')) {
      const path = sub.slice(3)
      if (!FORWARD.some(([m, re]) => m === method && re.test(path))) { sendJson(res, 404, { error: 'unknown call' }); return }
      const p = await loadPairing()
      if (!p) { sendJson(res, 409, { error: 'not paired' }); return }
      const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req)
      let r
      try {
        r = await call(p.url, method, `/api/v1${path}${url.search}`, { body, token: p.token, pin: p.cert })
      } catch (e) {
        sendJson(res, 502, { error: `Could not reach the machine: ${e.message}`, offline: true }); return
      }
      res.writeHead(r.status, {
        'content-type': String(r.headers['content-type'] || 'application/json'),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(r.body)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      try {
        await handle(req, res)
      } catch (e) {
        if (!res.headersSent) sendJson(res, e && e.status ? e.status : 500, { error: String((e && e.message) || e) })
        else res.destroy()
      }
    },
  }), `idea: ${PREFIX}`)
}

// Exposed for tests.
export const internals = { normalizeUrl, fingerprint, toPem, FORWARD, createHash }
