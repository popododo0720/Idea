// Shared test helpers: throwaway certificates, local HTTP requests, waiting.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let haveOpenssl
/** Whether `openssl` is on PATH (TLS tests skip without it). */
export function hasOpenssl() {
  if (haveOpenssl === undefined) {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); haveOpenssl = true } catch { haveOpenssl = false }
  }
  return haveOpenssl
}

/**
 * A fresh self-signed certificate for 127.0.0.1, made with openssl in a
 * temporary directory that is removed again. The key only lives in memory.
 * @returns {{cert: string, key: string}}
 */
export function selfSigned(cn = 'idea-test') {
  const dir = mkdtempSync(join(tmpdir(), 'idea-cert-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1',
      '-subj', `/CN=${cn}`, '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' })
    return { cert: readFileSync(join(dir, 'c'), 'utf8'), key: readFileSync(join(dir, 'k'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const open = new WeakMap() // server -> its live sockets

/** A temporary directory, removed again when the test `t` ends. */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Listen on an ephemeral 127.0.0.1 port; resolves the port. */
export function listen(server) {
  const sockets = new Set()
  open.set(server, sockets)
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** Close a server and every connection it still has. */
export function close(server) {
  return new Promise(resolve => {
    server.close(() => resolve())
    for (const s of open.get(server) || []) s.destroy()
  })
}

/**
 * One HTTP request to 127.0.0.1 without keep-alive.
 * @returns {Promise<{status: number, headers: object, text: string}>}
 */
export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Let pending promise callbacks and I/O settle until `cond()` holds. */
export async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: condition not reached')
    await new Promise(resolve => setImmediate(resolve))
  }
}
