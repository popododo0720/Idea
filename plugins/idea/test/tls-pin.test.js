import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { fingerprintOf, pinnedSocket, portOf } from '../lib/tls-pin.js'
import { close, hasOpenssl, listen, selfSigned, waitFor } from './helpers.js'

const noOpenssl = !hasOpenssl() && 'openssl is not installed'

// A TLS server that records what each client sent and answers "hello".
async function tlsServer(t, pair) {
  const received = []
  const tcp = { closed: 0 }
  const server = createTlsServer({ cert: pair.cert, key: pair.key }, s => {
    let got = ''
    s.on('data', c => { got += c })
    s.on('error', () => {})
    s.on('close', () => received.push(got))
    s.write('hello')
  })
  server.on('connection', s => s.on('close', () => { tcp.closed++ }))
  const port = await listen(server)
  t.after(() => close(server))
  return { port, received, tcp }
}

test('pinnedSocket accepts exactly the pinned certificate', { skip: noOpenssl }, async t => {
  const a = selfSigned('machine-a')
  const { port, received } = await tlsServer(t, a)
  const socket = await pinnedSocket({ host: '127.0.0.1', port, pin: a.cert })
  assert.equal(socket.getPeerCertificate().fingerprint256, fingerprintOf(a.cert))
  const first = await new Promise(resolve => socket.once('data', c => resolve(String(c))))
  assert.equal(first, 'hello')
  socket.end('ping')
  await waitFor(() => received.length === 1)
  socket.destroy()
  assert.deepEqual(received, ['ping'])
})

test('pinnedSocket refuses another certificate before anything is sent', { skip: noOpenssl }, async t => {
  const a = selfSigned('machine-a')
  const b = selfSigned('machine-b')
  const { port, received, tcp } = await tlsServer(t, b)
  await assert.rejects(pinnedSocket({ host: '127.0.0.1', port, pin: a.cert }), /different certificate than the one paired/)
  // The connection ended without any application data reaching the server.
  await waitFor(() => tcp.closed === 1)
  assert.equal(received.join(''), '')
})

test('pinnedSocket rejects when nothing listens or the peer is not TLS', { skip: noOpenssl }, async t => {
  const a = selfSigned()
  const plain = createNetServer(s => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  const port = await listen(plain)
  t.after(() => close(plain))
  await assert.rejects(pinnedSocket({ host: '127.0.0.1', port, pin: a.cert }))
  const gone = createNetServer()
  const free = await listen(gone)
  await close(gone)
  await assert.rejects(pinnedSocket({ host: '127.0.0.1', port: free, pin: a.cert }), { code: 'ECONNREFUSED' })
})

test('fingerprintOf is the SHA-256 fingerprint openssl prints', { skip: noOpenssl }, () => {
  const a = selfSigned()
  const out = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256'], { input: a.cert, encoding: 'utf8' })
  assert.equal(fingerprintOf(a.cert), out.trim().split('=')[1].toUpperCase())
  assert.match(fingerprintOf(a.cert), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.notEqual(fingerprintOf(a.cert), fingerprintOf(selfSigned().cert))
  assert.throws(() => fingerprintOf('not a certificate'))
})

test('portOf uses the explicit port or the scheme default', () => {
  assert.equal(portOf(new URL('https://machine:30443/x')), 30443)
  assert.equal(portOf(new URL('https://machine/x')), 443)
  assert.equal(portOf(new URL('http://machine')), 80)
  assert.equal(portOf(new URL('http://machine:8080')), 8080)
})
