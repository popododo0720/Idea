// idea-machine-sync: receives subscription sign-ins from the owner's dsh.
//
// The owner signs in to model subscriptions (Claude, ChatGPT, Copilot and the
// other pi-ai providers) in their own dsh. Those sign-ins are credential
// records under the `llm-pi-ai` scope, and dsh has no Remote API that writes a
// record. The idea plugin on the owner's side therefore sends them here, to
// `PUT /idea-sync/records`, through its logged-in view of this dsh.
//
// - Only signed-in callers of this dsh get through (`connection`, the same
//   check dsh's own routes use).
// - Only `llm-pi-ai/<provider>` records are accepted; nothing else in the
//   store can be written through this route.
// - A grant whose access token expires later than the incoming one is kept:
//   this dsh may have refreshed it since, and an older copy from the owner's
//   dsh would only undo that.
// - Record contents are never logged.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'idea-machine-sync'
export const inject = ['webServer', 'connection', 'credentials']

const PATH = '/idea-sync/records'
const MAX_BODY = 256 * 1024
const KEY = /^llm-pi-ai\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type Rec = { kind: 'grant', payload: unknown } | { kind: 'api-key', key?: string, env?: Record<string, string> }

function expiresOf(rec: unknown): number {
  const p = rec && typeof rec === 'object' ? (rec as { payload?: unknown }).payload : undefined
  const e = p && typeof p === 'object' ? (p as { expires?: unknown }).expires : undefined
  return typeof e === 'number' && Number.isFinite(e) ? e : 0
}

function valid(rec: unknown): rec is Rec {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Record<string, unknown>
  if (r.kind === 'grant') return 'payload' in r
  if (r.kind === 'api-key') {
    return (r.key === undefined || (typeof r.key === 'string' && r.key.length > 0))
      && (r.env === undefined || (typeof r.env === 'object' && r.env !== null))
  }
  return false
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { reject(Object.assign(new Error('JSON only'), { status: 415 })); return }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any) {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'PUT') { send(res, 405, { error: 'PUT only' }); return }
    const body = await readJson(req) as { records?: Record<string, unknown> }
    const records = body && typeof body.records === 'object' && body.records !== null ? body.records : undefined
    if (!records) { send(res, 400, { error: 'records missing' }); return }
    const entries = Object.entries(records)
    if (entries.some(([k, r]) => !KEY.test(k) || !valid(r))) { send(res, 400, { error: 'only llm-pi-ai records are accepted' }); return }
    let written = 0, kept = 0
    for (const [key, rec] of entries) {
      await ctx.credentials.modifyRecord(key, async (current: unknown) => {
        if (current && (current as Rec).kind === 'grant' && (rec as Rec).kind === 'grant' && expiresOf(current) > expiresOf(rec)) { kept++; return undefined }
        written++
        return rec
      })
    }
    ctx.logger.info('idea: received %d sign-ins (%d kept newer here)', written, kept)
    send(res, 200, { written, kept })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      try { await handle(req, res) } catch (e) {
        const err = e as { status?: number, message?: string }
        if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'could not store the sign-ins' })
        else res.destroy()
      }
    },
  }), `idea: ${PATH}`)
}
