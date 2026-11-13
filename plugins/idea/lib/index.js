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

export const name = 'idea'
export const inject = ['webServer', 'connection']

const PREFIX = '/idea'
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
 * One HTTPS call to the machine. With `pin`, only the paired certificate is
 * accepted (it is the only trust anchor and its fingerprint must match).
 * Without it (pairing), any certificate is accepted and returned, to be
 * pinned from then on.
 */
function call(base, method, path, { body, token, pin } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base)
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json' }
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = String(data.length) }
    if (token) headers.authorization = `Bearer ${token}`
    const tls = pin
      ? {
          ca: [pin],
          rejectUnauthorized: true,
          // The pinned certificate is self-signed for the machine's name; the
          // address used may be an IP. Identity is the exact certificate.
          checkServerIdentity: (_host, cert) =>
            cert.fingerprint256 === fingerprint(pin) ? undefined : new Error('idea: certificate changed'),
        }
      : { rejectUnauthorized: false }
    const req = httpsRequest(url, { method, headers, timeout: TIMEOUT_MS, agent: false, ...tls }, res => {
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
  ['DELETE', /^\/devices\/[0-9a-f]{12}$/],
]

export function apply(ctx) {
  // The machine's dsh, framed by the panel through a local proxy.
  const view = createViewProxy({
    upstream: async () => {
      if (process.env.IDEA_DEV_DSH_LOGIN) {
        // Development only: a dsh web started by hand, no pairing involved.
        const login = new URL(process.env.IDEA_DEV_DSH_LOGIN)
        return { url: login.origin, login: login.pathname + login.search }
      }
      const p = await loadPairing()
      if (!p) throw new Error('not paired')
      const r = await call(p.url, 'GET', '/api/v1/dsh', { token: p.token, pin: p.cert })
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
  ctx.effect(() => () => view.close(), 'idea: view proxy')

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
      try {
        sendJson(res, 200, { src: await view.enterUrl() })
      } catch (e) {
        sendJson(res, 502, { error: `could not reach the machine's dsh: ${e.message}` })
      }
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
      view.reset()
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
