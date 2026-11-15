// The Team tab's transcript: one agent's session, read from its VM's dsh
// (the `session/events` RPC) and turned into a short list of rows the panel
// can draw. The panel never gets raw model streaming chunks, reasoning, or
// unbounded tool output, and every credential-looking value is masked.

export const PAGE_MESSAGES = 40
export const MAX_ITEMS = 300
export const MAX_TEXT = 8000
export const MAX_ARGS = 2000
export const MAX_RESULT = 6000
export const PREVIEW = 600
const SUMMARY = 160
const TIMEOUT_MS = 15_000

const MASK = '[redacted]'

// Whole-value shapes of well known credentials.
const TOKEN_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi,
]
// "Authorization: Bearer x", and name=value / "name": "value" pairs whose name says secret.
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const NAMED = /((?:[A-Za-z0-9]+[_-])*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|private[_-]?key|credential|authorization|auth|cookie)s?[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?(?!(?:Bearer|Basic)\s))([^\s"',;&}]{6,})/gi

/** Mask values that look like credentials. */
export function redact(text) {
  let out = String(text)
  for (const re of TOKEN_SHAPES) out = out.replace(re, MASK)
  out = out.replace(BEARER, (_, kind) => `${kind} ${MASK}`)
  return out.replace(NAMED, (_, head) => head + MASK)
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => {
    if (!b || typeof b !== 'object') return ''
    if (b.type === 'text' && typeof b.text === 'string') return b.text
    if (b.type === 'image') return '[image]'
    if (b.type === 'file') return '[file]'
    return ''
  }).filter(Boolean).join('\n')
}

const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'name', 'message']

/** One line that says what a tool call does, from its raw JSON arguments. */
export function summarize(args) {
  let value
  try { value = JSON.parse(args) } catch { value = undefined }
  let line
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const key = SUMMARY_KEYS.find(k => typeof value[k] === 'string' && value[k])
    if (key) line = value[key]
    else {
      const first = Object.values(value).find(v => typeof v === 'string' && v)
      line = first ?? JSON.stringify(value)
    }
  } else {
    line = String(args)
  }
  return clip(redact(line).replace(/\s+/g, ' ').trim(), SUMMARY)
}

function prettyArgs(args) {
  let text
  try { text = JSON.stringify(JSON.parse(args), null, 2) } catch { text = String(args) }
  return clip(redact(text), MAX_ARGS)
}

function failureOf(reason) {
  if (!reason || reason.kind !== 'error' || !reason.error) return ''
  const e = reason.error
  return clip(redact(`${e.code ? e.code + ': ' : ''}${e.message || 'the turn failed'}`), 1000)
}

/**
 * Rows for a list of session events, oldest first. A tool call and its
 * result share one row (by `callId`); a result whose call is on an older page
 * stays a row of its own and the panel joins them by `callId`.
 */
export function renderEvents(events) {
  const sorted = [...events].filter(e => e && typeof e.seq === 'number' && e.data && typeof e.data === 'object')
    .sort((a, b) => a.seq - b.seq)
  const rows = []
  const byCall = new Map()
  for (const e of sorted) {
    const d = e.data
    const base = { seq: e.seq, t: typeof e.time === 'number' ? new Date(e.time).toISOString() : '' }
    switch (e.type) {
      case 'user/message': {
        const text = textOf(d.message && d.message.content)
        if (!text.trim()) break
        const source = d.message.source && d.message.source.kind
        rows.push({ ...base, kind: 'user', source: typeof source === 'string' ? source : 'user', text: clip(redact(text), MAX_TEXT) })
        break
      }
      case 'assistant/message': {
        const text = textOf(d.message && d.message.content)
        if (!text.trim()) break
        rows.push({ ...base, kind: 'assistant', text: clip(redact(text), MAX_TEXT), ...(d.interrupted ? { interrupted: true } : {}) })
        break
      }
      case 'tool/call': {
        const row = { ...base, kind: 'tool', callId: String(d.callId), name: String(d.name), summary: summarize(d.arguments), args: prettyArgs(d.arguments) }
        byCall.set(row.callId, row)
        rows.push(row)
        break
      }
      case 'tool/result': {
        const m = d.message || {}
        const full = redact(textOf(m.content))
        const result = clip(full, MAX_RESULT)
        const fields = {
          result, resultLength: full.length, ...(full.length > MAX_RESULT ? { resultTruncated: true } : {}),
          ...(m.isError ? { isError: true } : {}),
        }
        const call = byCall.get(String(m.toolCallId))
        if (call) Object.assign(call, fields)
        else rows.push({ ...base, kind: 'tool', callId: String(m.toolCallId), name: '', summary: '', args: '', ...fields })
        break
      }
      case 'turn/end': {
        const failure = failureOf(d.reason)
        if (failure) rows.push({ ...base, kind: 'error', text: failure })
        rows.push({ ...base, kind: 'turn-end', reason: d.reason && typeof d.reason.kind === 'string' ? d.reason.kind : 'completed' })
        break
      }
      default:
    }
  }
  return rows
}

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * One page of a session's transcript, newest page first: the events before
 * `before` (an event seq), or the newest when it is absent.
 * @returns {Promise<{items: object[], hasMore: boolean, oldest: number, newest: number}>}
 */
export async function transcriptPage({ view, session, before, timeoutMs = TIMEOUT_MS }) {
  const request = { address: { kind: 'session', sessionId: session }, maxMessages: PAGE_MESSAGES }
  if (before !== undefined) request.beforeSeq = before
  const page = await withTimeout(view.rpc('session/events', { request }), timeoutMs, 'session')
  const events = ((page && page.records) || []).map(r => r && r.event).filter(Boolean)
  const seqs = events.map(e => e.seq).filter(Number.isInteger)
  const kept = events.length > MAX_ITEMS ? [...events].sort((a, b) => a.seq - b.seq).slice(-MAX_ITEMS) : events
  const oldest = kept.length ? Math.min(...kept.map(e => e.seq)) : 0
  return {
    items: renderEvents(kept),
    hasMore: Boolean(page && page.hasMore) || kept.length < events.length,
    oldest,
    newest: seqs.length ? Math.max(...seqs) : 0,
  }
}
