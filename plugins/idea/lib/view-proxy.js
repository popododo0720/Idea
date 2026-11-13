// A local, private window onto the idea machine's dsh.
//
// The machine runs its own dsh (web profile); its sessions, workspaces and
// transcripts are what the idea panel shows, unchanged. A page of this dsh
// cannot frame the machine's dsh directly: its login cookie is SameSite=Strict
// and its API checks Host and Origin. So this plugin runs a small reverse
// proxy on 127.0.0.1 that
//
//   - logs in to the machine's dsh itself and keeps that cookie (the browser
//     never sees it),
//   - forwards every request and WebSocket of the framed page, with Host and
//     Origin rewritten to the machine's address,
//   - only answers a browser that entered through a one-time ticket this
//     plugin handed to the panel (its own HttpOnly, SameSite=Strict cookie),
//     and only for its own Host, against other local programs and DNS
//     rebinding.
//
// Upstream TLS is pinned to the machine's certificate, as the API calls are.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'
import { X509Certificate } from 'node:crypto'

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'])
const VIEW_COOKIE = 'idea_view'
const TICKET_TTL_MS = 60_000

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return undefined
}

/**
 * @param {object} opts
 * @param {() => Promise<{url: string, login: string, authority?: string, cert?: string}>} opts.upstream
 *   where the machine's dsh listens (url), the path of a fresh login (login),
 *   the Host it answers to when that differs from the address (authority),
 *   and the pinned certificate.
 */
export function createViewProxy({ upstream, log = () => {} }) {
  const viewSecret = randomBytes(32).toString('hex')
  const tickets = new Map() // ticket -> expiry
  let jar = ''              // upstream cookies: "a=b; c=d"
  let target                // { url: URL, authority: string, origin: string, cert }
  let server, port

  function tlsOptions() {
    if (!target || target.url.protocol !== 'https:') return {}
    if (!target.cert) return { rejectUnauthorized: false }
    const fp = new X509Certificate(target.cert).fingerprint256
    return {
      ca: [target.cert],
      rejectUnauthorized: true,
      checkServerIdentity: (_h, c) => (c.fingerprint256 === fp ? undefined : new Error('idea: certificate changed')),
    }
  }

  function absorbCookies(setCookie) {
    if (!setCookie) return
    const cookies = new Map(jar.split('; ').filter(Boolean).map(c => [c.split('=')[0], c]))
    for (const sc of [].concat(setCookie)) {
      const pair = sc.split(';')[0].trim()
      if (pair) cookies.set(pair.split('=')[0], pair)
    }
    jar = [...cookies.values()].join('; ')
  }

  function send(method, url, headers) {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, agent: false, ...tlsOptions() })
    return req
  }

  // Log in to the machine's dsh: its login URL sets the session cookie.
  async function login() {
    const up = await upstream()
    const url = new URL(up.url)
    const authority = up.authority || url.host
    target = { url, authority, origin: `${url.protocol}//${authority}`, cert: up.cert }
    await new Promise((resolve, reject) => {
      const req = send('GET', new URL(up.login, url), { host: authority, accept: 'text/html' })
      req.on('response', res => {
        absorbCookies(res.headers['set-cookie'])
        res.resume()
        res.on('end', () => (jar ? resolve() : reject(new Error(`idea: login to the machine's dsh failed (HTTP ${res.statusCode})`))))
      })
      req.on('error', reject)
      req.end()
    })
    log('logged in to the machine dsh')
  }

  function upstreamHeaders(reqHeaders) {
    const h = {}
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (HOP.has(k) || k === 'cookie' || k === 'host' || k === 'origin' || k === 'referer') continue
      h[k] = v
    }
    h.host = target.authority
    if (reqHeaders.origin) h.origin = target.origin
    if (reqHeaders.referer) {
      try { const r = new URL(reqHeaders.referer); h.referer = target.origin + r.pathname + r.search } catch { /* drop */ }
    }
    if (jar) h.cookie = jar
    return h
  }

  function allowed(req) {
    if (req.headers.host !== `127.0.0.1:${port}`) return false
    const c = cookieValue(req.headers.cookie, VIEW_COOKIE)
    return c !== undefined && same(c, viewSecret)
  }

  async function onRequest(req, res) {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/__idea/enter') {
      const t = url.searchParams.get('t') || ''
      const exp = tickets.get(t)
      tickets.delete(t)
      if (req.headers.host !== `127.0.0.1:${port}` || !exp || exp < Date.now()) { res.writeHead(403).end('expired'); return }
      res.writeHead(302, {
        'set-cookie': `${VIEW_COOKIE}=${viewSecret}; Path=/; HttpOnly; SameSite=Strict`,
        location: '/',
        'cache-control': 'no-store',
      }).end()
      return
    }
    if (!allowed(req)) { res.writeHead(403).end('forbidden'); return }
    if (!target || !jar) {
      try { await login() } catch (e) { res.writeHead(502).end(String(e.message)); return }
    }
    const forward = (retry) => {
      const up = send(req.method, new URL(url.pathname + url.search, target.url), upstreamHeaders(req.headers))
      up.on('response', ur => {
        absorbCookies(ur.headers['set-cookie'])
        if (ur.statusCode === 401 && retry && (req.method === 'GET' || req.method === 'HEAD')) {
          ur.resume()
          jar = ''
          login().then(() => forward(false), e => res.writeHead(502).end(String(e.message)))
          return
        }
        const headers = {}
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && k !== 'set-cookie') headers[k] = v
        res.writeHead(ur.statusCode || 502, headers)
        ur.pipe(res)
      })
      up.on('error', e => { if (!res.headersSent) res.writeHead(502).end(String(e.message)); else res.destroy() })
      if (retry && req.method !== 'GET' && req.method !== 'HEAD') req.pipe(up)
      else up.end()
    }
    forward(true)
  }

  async function onUpgrade(req, socket, head) {
    if (!allowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    if (!target || !jar) {
      try { await login() } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    }
    const u = target.url
    const portNum = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    const up = u.protocol === 'https:'
      ? tlsConnect({ host: u.hostname, port: portNum, servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname, ...tlsOptions() })
      : netConnect({ host: u.hostname, port: portNum })
    up.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const h = upstreamHeaders(req.headers)
      h.connection = 'Upgrade'
      h.upgrade = req.headers.upgrade
      let head1 = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(h)) for (const vv of [].concat(v)) head1 += `${k}: ${vv}\r\n`
      up.write(head1 + '\r\n')
      if (head && head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const kill = () => { socket.destroy(); up.destroy() }
    up.on('error', kill)
    socket.on('error', kill)
  }

  return {
    /** Start (once) and return a one-time URL the panel frames. */
    async enterUrl() {
      if (!server) {
        server = createServer((q, s) => { onRequest(q, s).catch(e => { if (!s.headersSent) s.writeHead(500).end(String(e.message)) }) })
        server.on('upgrade', (q, s, h) => { onUpgrade(q, s, h).catch(() => s.destroy()) })
        await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject))
        port = server.address().port
      }
      if (!jar) await login()
      for (const [t, exp] of tickets) if (exp < Date.now()) tickets.delete(t)
      const t = randomBytes(24).toString('hex')
      tickets.set(t, Date.now() + TICKET_TTL_MS)
      return `http://127.0.0.1:${port}/__idea/enter?t=${t}`
    },
    /** Forget the upstream session (unpair). */
    reset() { jar = ''; target = undefined },
    close() { if (server) server.close(); server = undefined },
  }
}
