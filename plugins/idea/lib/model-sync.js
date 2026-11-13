// Model settings follow this dsh to the idea machine.
//
// The agents run in the machine's dsh, but a person sets up models (DeepSeek,
// Claude or any other provider) in their own dsh. So this plugin copies, from
// this dsh to the machine's dsh:
//
//   - the user sections of the model settings namespaces (`llm-deepseek`, and
//     `llm-pi-ai`, which holds every other provider route the Models page adds),
//     when they are not empty,
//   - the credentials those sections reference (their `apiKeyEnv` names, plus
//     `DEEPSEEK_API_KEY`, which the desktop app's DeepSeek sign-in fills),
//     when this dsh has a value for them,
//   - the subscription sign-ins (Claude, ChatGPT, Copilot and the other pi-ai
//     providers, e.g. from the dsh-subscription-login console): the
//     credential records under the `llm-pi-ai` scope.
//
// It only adds and overwrites: nothing set on the machine itself is removed.
//
// Settings and keys go through the machine dsh's own Remote API
// (`settings/replace`, `credentials/set`), exactly what its Models page would
// do. dsh has no Remote API for records, so sign-ins go to the
// idea-machine-sync plugin of the machine dsh (`PUT /idea-sync/records`),
// which keeps a grant it has refreshed since. It runs when the
// pairing exists at start, after pairing, and whenever this dsh reports a
// changed setting or credential. Nothing is sent again while the content is
// unchanged. Values are never logged; only counts and error codes are.

import { createHash } from 'node:crypto'

const NAMESPACES = ['llm-deepseek', 'llm-pi-ai']
const ALWAYS = ['DEEPSEEK_API_KEY']
const DEBOUNCE_MS = 1500
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const RECORD_SCOPE = 'llm-pi-ai/'

/** Every `apiKeyEnv` string anywhere in a settings value. */
function keyRefs(value, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) keyRefs(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'apiKeyEnv' && typeof v === 'string' && REF.test(v)) out.add(v)
      else keyRefs(v, out)
    }
  }
  return out
}

/** What this dsh would hand the machine now, or undefined when it cannot tell. */
async function collect(ctx) {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  if (!settings || !credentials) return undefined
  const sections = {}
  const refs = new Set(ALWAYS)
  for (const d of settings.describe()) {
    if (!NAMESPACES.includes(d.ns)) continue
    // An empty section here says nothing: keep whatever the machine has.
    if (d.user && typeof d.user === 'object' && Object.keys(d.user).length > 0) sections[d.ns] = d.user
    keyRefs(d.value, refs)
  }
  const keys = {}
  for (const ref of refs) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) keys[ref] = hit.value
    } catch { /* unreadable: leave it out */ }
  }
  const records = {}
  for (const entry of await credentials.listRecords()) {
    const key = String(entry.key)
    if (!key.startsWith(RECORD_SCOPE)) continue
    try {
      const rec = await credentials.readRecord(entry.key)
      if (rec) records[key] = rec
    } catch { /* unreadable: leave it out */ }
  }
  return { sections, keys, records }
}

/**
 * @param {object} opts
 * @param {import('@deepseek-ai/cordis').Context} opts.ctx  this plugin's context
 * @param {(method: string, args: object) => Promise<unknown>} opts.rpc  machine dsh Remote API
 * @param {(method: string, path: string, value: unknown) => Promise<{status: number, text: string}>} opts.json
 *   one JSON request to the machine dsh
 * @param {() => Promise<boolean>} opts.paired
 */
export function createModelSync({ ctx, rpc, json, paired }) {
  let last = ''      // digest of what the machine has from us
  let timer
  let running = Promise.resolve()

  async function run() {
    if (!(await paired())) return
    const now = await collect(ctx)
    if (!now) return
    const digest = createHash('sha256').update(JSON.stringify(now)).digest('hex')
    if (digest === last) return
    for (const [ns, section] of Object.entries(now.sections)) {
      await rpc('settings/replace', { ns, section, expectedRevision: undefined })
    }
    for (const [ref, value] of Object.entries(now.keys)) {
      await rpc('credentials/set', { ref, value })
    }
    if (Object.keys(now.records).length > 0) {
      const r = await json('PUT', '/idea-sync/records', { records: now.records })
      if (r.status !== 200) throw new Error(`sign-ins: the machine dsh answered HTTP ${r.status}`)
    }
    last = digest
    ctx.logger.info('idea: model settings sent to the machine (%d sections, %d keys, %d sign-ins)',
      Object.keys(now.sections).length, Object.keys(now.keys).length, Object.keys(now.records).length)
  }

  /** Sync soon; calls in quick succession collapse into one. */
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running.then(run).catch(e => {
        ctx.logger.warn('idea: could not send model settings to the machine: %s', e && e.message)
      })
    }, DEBOUNCE_MS)
  }

  ctx.on('settings/document-updated', ns => { if (NAMESPACES.includes(ns)) schedule() })
  ctx.on('credentials/reference-updated', () => schedule())
  ctx.on('credentials/record-updated', key => { if (String(key).startsWith(RECORD_SCOPE)) schedule() })
  ctx.effect(() => () => clearTimeout(timer), 'idea: model sync timer')

  return {
    schedule,
    /** Forget what was sent (unpair): the next pairing gets everything. */
    reset() { last = '' },
  }
}

export const internals = { keyRefs }
