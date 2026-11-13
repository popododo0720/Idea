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
// - Only `llm-pi-ai/<provider>` records and the DeepSeek account sign-in
//   (`deepseek-account-platform/default`, a grant holding one long-lived
//   account token, no refresh) are accepted; nothing else in the store can be
//   written through this route.
// - A grant whose access token expires later than the incoming one is kept:
//   this dsh may have refreshed it since, and an older copy from the owner's
//   dsh would only undo that.
// - Record contents are never logged.

//
// `PUT /idea-sync/subscriptions` does the same for the dsh-plugin-subscriptions
// plugin (Claude, ChatGPT/Codex, Grok, Copilot, Antigravity), which keeps its
// sign-ins in its own file, `<dsh home>/plugins/subscriptions/auth.json`, and
// reads it on every use. The owner's sessions are merged into this dsh's file
// account by account, the later `expiresAt` winning, and the merged store is
// answered so the owner's dsh can take back a token refreshed here. Its
// `provider-settings.json` (display names, model lists; no secrets) is copied
// as is.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'idea-machine-sync'
export const inject = ['webServer', 'connection', 'credentials']

const PATH = '/idea-sync/records'
const SUBS_PATH = '/idea-sync/subscriptions'
const SUBS_PROVIDERS = ['codex', 'claude', 'grok', 'copilot', 'antigravity']

type Session = { accessToken: string, refreshToken: string, expiresAt: number, [k: string]: unknown }
type Entry = { default?: string, accounts: Record<string, Session>, [k: string]: unknown }
type Store = Record<string, Entry>

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
const subsFile = (file: string) => join(dshHome(), 'plugins', 'subscriptions', file)

function isSession(v: unknown): v is Session {
  const s = v as Session
  return !!s && typeof s === 'object' && typeof s.accessToken === 'string' && s.accessToken.length > 0
    && typeof s.refreshToken === 'string' && s.refreshToken.length > 0
    && typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt)
}

/** Keep only well-formed provider entries (the plugin's own multi-account format). */
function cleanStore(v: unknown): Store {
  const out: Store = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const p of SUBS_PROVIDERS) {
    const e = (v as Record<string, unknown>)[p] as Entry | undefined
    if (!e || typeof e !== 'object' || !e.accounts || typeof e.accounts !== 'object') continue
    const accounts: Record<string, Session> = {}
    for (const [k, s] of Object.entries(e.accounts)) if (isSession(s)) accounts[k] = s
    if (Object.keys(accounts).length === 0) continue
    out[p] = { ...e, accounts, default: typeof e.default === 'string' && e.default in accounts ? e.default : Object.keys(accounts)[0] }
  }
  return out
}

/** Merge two stores account by account; the session that expires later wins. */
function mergeStores(mine: Store, theirs: Store): Store {
  const out: Store = { ...mine }
  for (const [p, e] of Object.entries(theirs)) {
    const cur = out[p]
    if (!cur) { out[p] = e; continue }
    const accounts = { ...cur.accounts }
    for (const [k, s] of Object.entries(e.accounts)) {
      if (!accounts[k] || s.expiresAt > accounts[k].expiresAt) accounts[k] = s
    }
    out[p] = { ...cur, ...e, accounts, default: e.default && e.default in accounts ? e.default : cur.default }
  }
  return out
}

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return undefined
    throw e
  }
}

/** Atomic write with owner-only permissions, as the plugin itself writes. */
async function writeJsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
const MAX_BODY = 256 * 1024
const KEY = /^llm-pi-ai\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$|^deepseek-account-platform\/default$/

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
    if (entries.some(([k, r]) => !KEY.test(k) || !valid(r)
      || (k.startsWith('deepseek-account-platform/') && (r as Rec).kind !== 'grant'))) {
      send(res, 400, { error: 'only llm-pi-ai records and the DeepSeek account sign-in are accepted' }); return
    }
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

  async function handleSubscriptions(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'PUT') { send(res, 405, { error: 'PUT only' }); return }
    const body = await readJson(req) as { auth?: unknown, providerSettings?: unknown }
    if (!body || typeof body !== 'object') { send(res, 400, { error: 'bad body' }); return }
    const theirs = cleanStore(body.auth)
    const mine = cleanStore(await readJsonFile(subsFile('auth.json')))
    const merged = mergeStores(mine, theirs)
    if (JSON.stringify(merged) !== JSON.stringify(mine)) await writeJsonFile(subsFile('auth.json'), merged)
    if (body.providerSettings && typeof body.providerSettings === 'object' && !Array.isArray(body.providerSettings)) {
      await writeJsonFile(subsFile('provider-settings.json'), body.providerSettings)
    }
    ctx.logger.info('idea: subscription sign-ins merged (%d providers)', Object.keys(merged).length)
    send(res, 200, { auth: merged })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUBS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      try { await handleSubscriptions(req, res) } catch (e) {
        const err = e as { status?: number, message?: string }
        if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'could not store the sign-ins' })
        else res.destroy()
      }
    },
  }), `idea: ${SUBS_PATH}`)

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
