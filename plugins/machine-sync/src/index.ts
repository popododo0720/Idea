// idea-machine-sync: receives sign-ins from the owner's dsh.
//
// The owner signs in to the DeepSeek account in their own dsh. That sign-in is
// a credential record (`deepseek-account-platform/default`, a grant holding one
// long-lived account token, no refresh), and dsh has no Remote API that writes
// a record. The idea plugin on the owner's side therefore sends it here, to
// `PUT /idea-sync/records`, through its logged-in view of this dsh.
//
// - Only signed-in callers of this dsh get through (`connection`, the same
//   check dsh's own routes use).
// - Only that one record is accepted; nothing else in the store can be
//   written through this route.
// - A grant whose access token expires later than the incoming one is kept.
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
//
// Worker VMs (deploy/apps/workers) are agent dsh instances too, but nobody
// signs in on them. This plugin moves the models on from the agent dsh:
//
// - On the agent dsh, `GET /idea-sync/export` answers everything a worker
//   needs: the `llm-deepseek`, `llm-pi-ai` and `agent-default-model`
//   settings sections, the keys they reference, the DeepSeek account
//   sign-in, the subscription sign-ins and pstack's per-role models. Only a caller presenting the shared token
//   (`/etc/idea/sync/token`, Secret `idea-sync`, made by the controller) gets
//   it; the same token may also send refreshed subscription sessions to
//   `PUT /idea-sync/subscriptions`.
// - On a worker VM (`IDEA_SYNC_SOURCE` set), it pulls that every 30 seconds
//   over TLS pinned to the machine's certificate, applies what changed, and
//   sends back subscription sessions it refreshed itself.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'idea-machine-sync'
export const inject = ['webServer', 'connection', 'credentials', 'settings']

const PATH = '/idea-sync/records'
const SUBS_PATH = '/idea-sync/subscriptions'
const EXPORT_PATH = '/idea-sync/export'
const TOKEN_FILE = process.env.IDEA_SYNC_TOKEN_FILE || '/etc/idea/sync/token'
const CERT_FILE = process.env.IDEA_SYNC_CERT_FILE || '/etc/idea/tls/tls.crt'
// Model settings a worker VM takes over: provider routes and the default model.
const NAMESPACES = ['llm-deepseek', 'llm-pi-ai', 'agent-default-model']
// pstack's model per role (dsh-pstack).
const PSTACK_MODELS = 'pstack-models.mdc'
const DEEPSEEK_ACCOUNT = 'deepseek-account-platform/default'
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const PULL_MS = 30_000
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
const KEY = /^deepseek-account-platform\/default$/

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

/** The shared worker token, or undefined when there is none. */
async function syncToken(): Promise<string | undefined> {
  try {
    const t = (await readFile(TOKEN_FILE, 'utf8')).trim()
    return t.length >= 32 ? t : undefined
  } catch { return undefined }
}

/** Whether the request carries the shared worker token. */
async function hasSyncToken(req: IncomingMessage): Promise<boolean> {
  const want = await syncToken()
  const got = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (!want || !got) return false
  const a = Buffer.from(createHash('sha256').update(got).digest('hex'))
  const b = Buffer.from(createHash('sha256').update(want).digest('hex'))
  return timingSafeEqual(a, b)
}

/** Every `apiKeyEnv` string anywhere in a settings value. */
function keyRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) keyRefs(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'apiKeyEnv' && typeof v === 'string' && REF.test(v)) out.add(v)
      else keyRefs(v, out)
    }
  }
  return out
}

/** Sessions in `theirs` that are newer than (or missing from) `mine`. */
function newerIn(theirs: Store, mine: Store): boolean {
  for (const [p, e] of Object.entries(theirs)) {
    for (const [k, s] of Object.entries(e.accounts)) {
      const m = mine[p]?.accounts[k]
      if (!m || s.expiresAt > m.expiresAt) return true
    }
  }
  return false
}

type Export = {
  sections: Record<string, unknown>
  keys: Record<string, string>
  records: Record<string, unknown>
  auth: Store
  providerSettings?: unknown
  pstackModels?: string
}

/** One JSON request to the agent dsh, TLS pinned to the machine's certificate. */
async function pinnedJson(url: URL, method: string, token: string, body?: unknown): Promise<{ status: number, value: unknown }> {
  const pem = await readFile(CERT_FILE, 'utf8')
  const pinned = new X509Certificate(pem).raw
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      ca: pem,
      // The certificate is self-signed for the machine's name; what counts is
      // that it is exactly this one.
      checkServerIdentity: (_host, cert) => cert.raw.equals(pinned) ? undefined : new Error('unexpected certificate'),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
      },
      timeout: 30_000,
    }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => { size += c.length; if (size <= 4 * MAX_BODY) chunks.push(c) })
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }) } catch { resolve({ status: res.statusCode || 0, value: null }) }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any) {
  const source = process.env.IDEA_SYNC_SOURCE

  /** What a worker VM needs from this (the agent) dsh. */
  async function collect(): Promise<Export> {
    const sections: Record<string, unknown> = {}
    const refs = new Set<string>(['DEEPSEEK_API_KEY'])
    for (const d of ctx.settings.describe()) {
      if (!NAMESPACES.includes(d.ns)) continue
      if (d.user && typeof d.user === 'object' && Object.keys(d.user).length > 0) sections[d.ns] = d.user
      keyRefs(d.value, refs)
    }
    const keys: Record<string, string> = {}
    for (const ref of refs) {
      try {
        const hit = await ctx.credentials.resolve(ref)
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) keys[ref] = hit.value
      } catch { /* unreadable: leave it out */ }
    }
    const records: Record<string, unknown> = {}
    try {
      const rec = await ctx.credentials.readRecord(DEEPSEEK_ACCOUNT)
      if (rec) records[DEEPSEEK_ACCOUNT] = rec
    } catch { /* none */ }
    const auth = cleanStore(await readJsonFile(subsFile('auth.json')))
    const providerSettings = await readJsonFile(subsFile('provider-settings.json'))
    let pstackModels: string | undefined
    try { pstackModels = await readFile(join(dshHome(), PSTACK_MODELS), 'utf8') } catch { /* none */ }
    return {
      sections, keys, records, auth,
      ...(providerSettings ? { providerSettings } : {}),
      ...(pstackModels !== undefined ? { pstackModels } : {}),
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'PUT') { send(res, 405, { error: 'PUT only' }); return }
    const body = await readJson(req) as { records?: Record<string, unknown> }
    const records = body && typeof body.records === 'object' && body.records !== null ? body.records : undefined
    if (!records) { send(res, 400, { error: 'records missing' }); return }
    const entries = Object.entries(records)
    if (entries.some(([k, r]) => !KEY.test(k) || !valid(r) || (r as Rec).kind !== 'grant')) {
      send(res, 400, { error: 'only the DeepSeek account sign-in is accepted' }); return
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
      // The owner's dsh (signed in), or a worker VM (shared token).
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined && (source || !(await hasSyncToken(req)))) { res.statusCode = rejection; res.end(); return }
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

  if (!source) {
    // The agent dsh: answer worker VMs.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: EXPORT_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return }
        if (!(await hasSyncToken(req))) { res.statusCode = 401; res.end(); return }
        try { send(res, 200, await collect()) } catch {
          if (!res.headersSent) send(res, 500, { error: 'could not collect the models' })
        }
      },
    }), `idea: ${EXPORT_PATH}`)
    return
  }

  // A worker VM: pull from the agent dsh.
  let last = ''
  let running = false
  async function pull() {
    if (running) return
    running = true
    try {
      const token = await syncToken()
      if (!token) return
      const base = new URL(source!)
      const r = await pinnedJson(new URL(EXPORT_PATH, base), 'GET', token)
      if (r.status !== 200 || !r.value || typeof r.value !== 'object') throw new Error(`the agent dsh answered HTTP ${r.status}`)
      const ex = r.value as Export
      const mine = cleanStore(await readJsonFile(subsFile('auth.json')))
      const digest = createHash('sha256').update(JSON.stringify([ex, mine])).digest('hex')
      if (digest === last) return
      for (const [ns, section] of Object.entries(ex.sections || {})) {
        if (!NAMESPACES.includes(ns) || !section || typeof section !== 'object') continue
        const cur = ctx.settings.describe().find((d: { ns: string }) => d.ns === ns)
        if (cur && JSON.stringify(cur.user) === JSON.stringify(section)) continue
        await ctx.settings.replace(ns, section)
      }
      for (const [ref, value] of Object.entries(ex.keys || {})) {
        if (!REF.test(ref) || typeof value !== 'string' || !value) continue
        let cur: string | undefined
        try { cur = (await ctx.credentials.resolve(ref))?.value } catch { /* none */ }
        if (cur !== value) await ctx.credentials.set(ref, value)
      }
      const rec = ex.records?.[DEEPSEEK_ACCOUNT]
      if (rec && valid(rec) && (rec as Rec).kind === 'grant') {
        await ctx.credentials.modifyRecord(DEEPSEEK_ACCOUNT, async (current: unknown) =>
          current && expiresOf(current) >= expiresOf(rec) ? undefined : rec)
      }
      const theirs = cleanStore(ex.auth)
      const merged = mergeStores(mine, theirs)
      if (JSON.stringify(merged) !== JSON.stringify(mine)) await writeJsonFile(subsFile('auth.json'), merged)
      if (ex.providerSettings && typeof ex.providerSettings === 'object' && !Array.isArray(ex.providerSettings)) {
        const cur = await readJsonFile(subsFile('provider-settings.json'))
        if (JSON.stringify(cur) !== JSON.stringify(ex.providerSettings)) await writeJsonFile(subsFile('provider-settings.json'), ex.providerSettings)
      }
      if (typeof ex.pstackModels === 'string' && ex.pstackModels.length <= MAX_BODY) {
        const path = join(dshHome(), PSTACK_MODELS)
        let cur: string | undefined
        try { cur = await readFile(path, 'utf8') } catch { /* none */ }
        if (cur !== ex.pstackModels) await writeFile(path, ex.pstackModels, { mode: 0o644 })
      }
      // Sessions refreshed here go back, so the agent dsh (and the owner's
      // dsh after it) does not keep a refresh token that no longer works.
      if (newerIn(merged, theirs)) {
        const back = await pinnedJson(new URL(SUBS_PATH, base), 'PUT', token, { auth: merged })
        if (back.status !== 200) throw new Error(`sending refreshed sign-ins: HTTP ${back.status}`)
      }
      last = createHash('sha256').update(JSON.stringify([ex, merged])).digest('hex')
      ctx.logger.info('idea: models pulled from the agent dsh (%d sections, %d keys, %d subscription providers)',
        Object.keys(ex.sections || {}).length, Object.keys(ex.keys || {}).length, Object.keys(merged).length)
    } finally {
      running = false
    }
  }
  const tick = () => { pull().catch(e => ctx.logger.warn('idea: could not pull models from the agent dsh: %s', e && e.message)) }
  const timer = setInterval(tick, PULL_MS)
  const first = setTimeout(tick, 5_000)
  ctx.effect(() => () => { clearInterval(timer); clearTimeout(first) }, 'idea: model pull timer')
}
