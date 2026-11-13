// TLS connections pinned to one exact certificate.
//
// The idea machine serves a self-signed certificate that the plugin pins at
// pairing time. Using it as the only trust anchor (`ca: [pin]`) works with
// OpenSSL but not everywhere: the dsh desktop app runs plugins in Electron's
// Node (BoringSSL), which does not accept a self-signed leaf certificate as a
// root ("unable to verify the first certificate"). So no chain is verified at
// all: the handshake completes, the peer certificate's SHA-256 fingerprint
// is compared with the pinned one, and only then is the socket handed to the
// caller. Nothing is written to the connection before that check.

import { X509Certificate } from 'node:crypto'
import { connect } from 'node:tls'

const TIMEOUT_MS = 20_000

/** SHA-256 fingerprint of a PEM certificate, as Node prints it (AA:BB:...). */
export function fingerprintOf(pem) {
  return new X509Certificate(pem).fingerprint256
}

/**
 * Open a TLS connection and resolve once the peer is the pinned certificate.
 * @param {{host: string, port: number, pin: string}} opts  pin is a PEM certificate
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export function pinnedSocket({ host, port, pin }) {
  const want = fingerprintOf(pin)
  return new Promise((resolve, reject) => {
    const isIP = /^[\d.]+$/.test(host) || host.includes(':')
    const socket = connect({
      host,
      port,
      // SNI only for names; the certificate is checked by fingerprint below.
      ...(isIP ? {} : { servername: host }),
      rejectUnauthorized: false,
    })
    const timer = setTimeout(() => socket.destroy(new Error('idea: the machine did not answer')), TIMEOUT_MS)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const peer = socket.getPeerCertificate()
      if (!peer || peer.fingerprint256 !== want) {
        socket.destroy()
        reject(new Error('idea: the machine presented a different certificate than the one paired'))
        return
      }
      resolve(socket)
    })
    socket.once('error', e => { clearTimeout(timer); reject(e) })
  })
}

/** Default port of a URL. */
export function portOf(url) {
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
}
