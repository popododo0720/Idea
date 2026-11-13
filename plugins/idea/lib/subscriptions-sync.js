// Subscription sign-ins of dsh-plugin-subscriptions follow this dsh to the machine.
//
// The owner signs in to Claude, ChatGPT/Codex, Grok, Copilot or Antigravity
// with the dsh-plugin-subscriptions plugin in their own dsh. That plugin keeps
// the sessions in its own file, `<dsh home>/plugins/subscriptions/auth.json`,
// and reads it on every use. The machine's agent dsh runs the same plugin;
// this module keeps the two files in step:
//
//   - every 30 seconds it reads this dsh's file (and `provider-settings.json`,
//     display names and model lists, no secrets) and, when either changed or
//     the machine has not had them yet, sends both to the machine
//     (`PUT /idea-sync/subscriptions`, plugins/machine-sync);
//   - the machine merges account by account, the later `expiresAt` winning,
//     and answers the merged store. Sessions the machine refreshed since are
//     written back here, so a refresh on either side does not leave the other
//     with a revoked refresh token.
//
// Nothing is removed on either side (a sign-out here does not sign the
// machine out). Token values are never logged.

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const POLL_MS = 30_000
const PROVIDERS = ['codex', 'claude', 'grok', 'copilot', 'antigravity']

/** The dsh home the subscriptions plugin uses: dsh's own helper when it resolves. */
async function homes() {
  const out = []
  try {
    const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
    out.push(dshHomePath())
  } catch { /* not resolvable from this package */ }
  if (process.env.DSH_HOME) out.push(process.env.DSH_HOME)
  out.push(join(homedir(), '.dsh'))
  return [...new Set(out)]
}

async function subsDir() {
  const all = await homes()
  for (const h of all) {
    const d = join(h, 'plugins', 'subscriptions')
    try { await stat(join(d, 'auth.json')); return d } catch { /* next */ }
  }
  return undefined
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

function isSession(s) {
  return !!s && typeof s === 'object' && typeof s.accessToken === 'string' && s.accessToken.length > 0
    && typeof s.refreshToken === 'string' && s.refreshToken.length > 0
    && typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt)
}

/** Sessions the machine has that are newer than (or missing from) ours. */
function newerThere(mine, theirs) {
  for (const p of PROVIDERS) {
    const t = theirs && theirs[p]
    if (!t || !t.accounts) continue
    const m = mine && mine[p] && mine[p].accounts
    for (const [k, s] of Object.entries(t.accounts)) {
      if (!isSession(s)) continue
      if (!m || !m[k] || (isSession(m[k]) && s.expiresAt > m[k].expiresAt)) return true
    }
  }
  return false
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
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

/**
 * @param {object} opts
 * @param {import('@deepseek-ai/cordis').Context} opts.ctx
 * @param {(method: string, path: string, value: unknown) => Promise<{status: number, text: string}>} opts.json
 * @param {() => Promise<boolean>} opts.paired
 */
export function createSubscriptionsSync({ ctx, json, paired }) {
  let last = ''
  let running = false

  async function run() {
    if (running || !(await paired())) return
    running = true
    try {
      const dir = await subsDir()
      if (!dir) return
      const auth = await readJson(join(dir, 'auth.json'))
      if (!auth || typeof auth !== 'object') return
      const providerSettings = await readJson(join(dir, 'provider-settings.json'))
      const digest = createHash('sha256').update(JSON.stringify([auth, providerSettings ?? null])).digest('hex')
      if (digest === last) return
      const r = await json('PUT', '/idea-sync/subscriptions', { auth, ...(providerSettings ? { providerSettings } : {}) })
      if (r.status !== 200) throw new Error(`the machine dsh answered HTTP ${r.status}`)
      let merged
      try { merged = JSON.parse(r.text).auth } catch { /* below */ }
      if (merged && newerThere(auth, merged)) {
        // Re-read right before writing: the plugin may have written meanwhile.
        const now = await readJson(join(dir, 'auth.json'))
        if (JSON.stringify(now) === JSON.stringify(auth)) {
          await writeAtomic(join(dir, 'auth.json'), merged)
          last = createHash('sha256').update(JSON.stringify([merged, providerSettings ?? null])).digest('hex')
          ctx.logger.info('idea: subscription sign-ins synced with the machine (took back newer sessions)')
          return
        }
        return // changed under us: next round
      }
      last = digest
      ctx.logger.info('idea: subscription sign-ins synced with the machine')
    } finally {
      running = false
    }
  }

  const tick = () => { run().catch(e => ctx.logger.warn('idea: could not sync subscription sign-ins: %s', e && e.message)) }
  const timer = setInterval(tick, POLL_MS)
  ctx.effect(() => () => clearInterval(timer), 'idea: subscriptions sync timer')
  setTimeout(tick, 2_000)

  return {
    now: tick,
    reset() { last = '' },
  }
}

export const internals = { newerThere }
