// idea-team: agent teams whose members run on separate VMs and talk to each
// other directly.
//
// dsh's own Agent Teams keep every teammate inside one dsh process. On an
// idea machine a teammate should be a session on a worker VM (a Kata VM of
// its own), like a separate PC. This plugin, installed on the agent dsh and
// on every worker VM, gives agents the same kind of tools across VMs:
//
// - `team_spawn` (the lead): the controller only picks a worker VM with a
//   free slot (adding one when the cluster has room). The lead's dsh then
//   asks that VM's dsh directly to open a session for the teammate.
// - `team_send` (anyone): the sender's dsh posts the message straight to the
//   receiving VM's dsh, which hands it to the receiving session: at its next
//   step while it is working (steer), or as a new turn while it is idle.
//   Nothing sits in between: no controller, no relay.
// - `team_list`, `team_stop`.
//
// Peers prove themselves with the machine's team token (`/etc/idea/team/token`,
// Secret `idea-team`, made by the controller) and pin the machine's TLS
// certificate, which every VM serves. Every VM keeps a log of the messages it
// sent and received (`<dsh home>/idea-team/log.jsonl`); the owner's idea panel
// reads it to show the conversation.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { X509Certificate, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'idea-team'
export const inject = ['webServer', 'connection', 'tools', 'sessionController', 'workspaceController']

const TOKEN_FILE = process.env.IDEA_TEAM_TOKEN_FILE || '/etc/idea/team/token'
const CERT_FILE = process.env.IDEA_TEAM_CERT_FILE || '/etc/idea/tls/tls.crt'
const CONTROLLER = (process.env.IDEA_CONTROLLER || 'http://idea-controller.idea-system.svc:8080').replace(/\/+$/, '')
const WORK_NS = process.env.IDEA_WORK_NS || 'idea-work'
// This VM's name: `idea-dsh` (the agent dsh) or `idea-worker-<n>`.
const SELF = process.env.IDEA_VM || 'idea-dsh'
const WORK_ROOT = '/home/idea/state/team'

const VM = /^(idea-dsh|idea-worker-\d{1,3})$/
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const TEAM = /^[0-9a-f]{8}$/
const LEAD = 'lead'
const MAX_TEXT = 20_000
const MAX_BODY = 256 * 1024
const PLACEMENT_WAIT_MS = 5 * 60_000

type Member = { name: string, vm: string, session: string, role: string }
type Local = { team: string, name: string, lead: { vm: string, name: string } }
type State = {
  /** Teams led from this VM: the whole roster. */
  led: Record<string, { lead: Member, members: Member[] }>
  /** Sessions on this VM that are team members, by session id. */
  local: Record<string, Local>
  /** The roster as last sent by each team's lead. */
  rosters: Record<string, Member[]>
  /** Members stopped by the lead, by `<team>/<name>`. */
  stopped: Record<string, true>
}
type LogLine = { t: string, team: string, from: string, fromVm: string, to: string, toVm: string, text: string, dir: 'in' | 'out' }

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const stateFile = () => join(home(), 'idea-team', 'state.json')
const logFile = () => join(home(), 'idea-team', 'log.jsonl')

export function authority(vm: string): string {
  if (!VM.test(vm)) throw new Error(`not a VM of this machine: ${JSON.stringify(vm)}`)
  return vm === 'idea-dsh' ? `idea-dsh.${WORK_NS}.svc:4443` : `${vm}.idea-worker.${WORK_NS}.svc:4443`
}

async function teamToken(): Promise<string | undefined> {
  try {
    const t = (await readFile(TOKEN_FILE, 'utf8')).trim()
    return t.length >= 32 ? t : undefined
  } catch { return undefined }
}

async function hasTeamToken(req: IncomingMessage): Promise<boolean> {
  const want = await teamToken()
  const got = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (!want || !got) return false
  const a = Buffer.from(createHash('sha256').update(got).digest('hex'))
  const b = Buffer.from(createHash('sha256').update(want).digest('hex'))
  return timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(c as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}

type Reply = { status: number, value: any }

/** One JSON request to another VM's dsh, TLS pinned to the machine's certificate. */
async function peer(vm: string, method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<Reply> {
  const token = await teamToken()
  if (!token) throw new Error('this VM has no team token yet (Secret idea-team)')
  const pem = await readFile(CERT_FILE, 'utf8')
  const pinned = new X509Certificate(pem).raw
  const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(`https://${authority(vm)}${path}`), {
      method,
      ca: pem,
      // Every VM serves the machine's one certificate; what counts is that it
      // is exactly this one.
      checkServerIdentity: (_host, cert) => cert.raw.equals(pinned) ? undefined : new Error('unexpected certificate'),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
      },
      timeout: 30_000,
      signal,
    }, res => collect(res, resolve, reject))
    req.on('timeout', () => req.destroy(new Error(`${vm} did not answer`)))
    req.on('error', reject)
    req.end(data)
  })
}

/** Ask the controller for a worker VM with a free slot. */
async function placement(signal?: AbortSignal): Promise<Reply> {
  const token = await teamToken()
  if (!token) throw new Error('this VM has no team token yet (Secret idea-team)')
  const data = Buffer.from('{}')
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(`${CONTROLLER}/team/placement`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(data.length) },
      timeout: 30_000,
      signal,
    }, res => collect(res, resolve, reject))
    req.on('timeout', () => req.destroy(new Error('the controller did not answer')))
    req.on('error', reject)
    req.end(data)
  })
}

function collect(res: IncomingMessage, resolve: (r: Reply) => void, reject: (e: Error) => void) {
  const chunks: Buffer[] = []
  let size = 0
  res.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c) })
  res.on('end', () => {
    let value: unknown = null
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { /* not JSON */ }
    resolve({ status: res.statusCode || 0, value })
  })
  res.on('error', reject)
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
  })
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any) {
  let state: State = { led: {}, local: {}, rosters: {}, stopped: {} }
  let loaded: Promise<void> | undefined
  let saving = Promise.resolve()

  function load() {
    loaded ??= readFile(stateFile(), 'utf8').then(text => {
      const v = JSON.parse(text)
      state = { led: v.led ?? {}, local: v.local ?? {}, rosters: v.rosters ?? {}, stopped: v.stopped ?? {} }
    }, () => { /* first start */ })
    return loaded
  }

  function save() {
    const text = JSON.stringify(state, null, 2)
    saving = saving.then(async () => {
      const file = stateFile()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file + '.tmp', text, { mode: 0o600 })
      await rename(file + '.tmp', file)
    }).catch(() => { /* next save retries */ })
    return saving
  }

  async function log(line: Omit<LogLine, 't'>) {
    try {
      await mkdir(dirname(logFile()), { recursive: true })
      await appendFile(logFile(), JSON.stringify({ t: new Date().toISOString(), ...line }) + '\n', { mode: 0o600 })
    } catch { /* the log is for the panel only */ }
  }

  async function running(session: string): Promise<boolean | undefined> {
    try { return (await ctx.sessionController.state({ sessionId: session })).running } catch { return undefined }
  }

  /** Hand text to a session on this VM: at its next step if it is working, else as a new turn. */
  async function deliver(session: string, text: string, signal?: AbortSignal) {
    const mode = (await running(session)) ? 'steer' : 'queue'
    const request = { requestId: randomUUID(), sessionId: session, mode, content: [{ type: 'text', text }] }
    try {
      await ctx.sessionController.prompt(request, signal ?? AbortSignal.timeout(30_000))
    } catch (e) {
      if (mode !== 'steer') throw e
      // The turn ended in between: start a new one.
      await ctx.sessionController.prompt({ ...request, requestId: randomUUID(), mode: 'queue' }, signal ?? AbortSignal.timeout(30_000))
    }
  }

  function rosterText(team: string, me: string): string {
    const roster = state.rosters[team] ?? []
    return roster.filter(m => m.name !== me).map(m => `- ${m.name} (${m.role}) on ${m.vm}`).join('\n') || '- (nobody else yet)'
  }

  /** The caller's membership, from the agent the tool runs for. */
  function memberOf(exec: any): { session: string, local?: Local } {
    const session = exec?.agent?.id
    if (typeof session !== 'string') throw new Error('this tool needs a session')
    return { session, local: state.local[session] }
  }

  async function broadcastRoster(team: string) {
    const t = state.led[team]
    const roster = [t.lead, ...t.members]
    state.rosters[team] = roster
    await save()
    const vms = new Set(t.members.map(m => m.vm))
    vms.delete(SELF)
    await Promise.all([...vms].map(vm => peer(vm, 'POST', '/idea-team/roster', { team, roster }).catch(() => undefined)))
  }

  // ------------------------------------------------------------- tools

  ctx.tools.register(defineTool({
    name: 'team_spawn',
    description: 'Start a teammate on a worker VM of this machine (a separate Kata VM, like another PC) and give it its task. ' +
      'The calling session becomes the team lead. The teammate can message you and the other teammates directly with team_send, ' +
      'and you get its messages as new user messages. Give each teammate one clear piece of work, the Forgejo repository (owner/name) ' +
      'to clone, and what done means.',
    parameters: {
      name: { type: 'string', required: true, description: 'Teammate name: lowercase letters, digits, dashes (e.g. "api", "tests")' },
      role: { type: 'string', required: true, description: 'One line: what this teammate is responsible for' },
      task: { type: 'string', required: true, description: 'The full task: repository, what to build, acceptance criteria, who to coordinate with' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { name: string, role: string, task: string }, exec: any) {
      await load()
      const name = String(args.name).trim()
      if (!NAME.test(name) || name === LEAD) throw new Error('name: lowercase letters, digits and dashes, starting with a letter; not "lead"')
      const role = String(args.role).trim().slice(0, 200)
      const task = String(args.task).slice(0, MAX_TEXT)
      const me = memberOf(exec)
      let team: string
      if (me.local) {
        if (me.local.name !== LEAD || !state.led[me.local.team]) throw new Error('only the team lead starts teammates; ask the lead with team_send')
        team = me.local.team
      } else {
        // Teams are led from the agent dsh, where the owner plans work.
        if (SELF !== 'idea-dsh') throw new Error('teams are led from the agent dsh (idea-dsh); report to your lead instead')
        team = randomBytes(4).toString('hex')
        const lead: Member = { name: LEAD, vm: SELF, session: me.session, role: 'team lead' }
        state.led[team] = { lead, members: [] }
        state.local[me.session] = { team, name: LEAD, lead: { vm: SELF, name: LEAD } }
        state.rosters[team] = [lead]
        await save()
      }
      const t = state.led[team]
      if (t.members.some(m => m.name === name)) throw new Error(`there already is a teammate ${name} in this team`)

      // Where: the controller picks a worker VM with a free slot.
      const until = Date.now() + PLACEMENT_WAIT_MS
      let vm = ''
      let why = ''
      while (!vm) {
        const r = await placement(exec.signal)
        if (r.status === 200 && typeof r.value?.vm === 'string' && VM.test(r.value.vm)) { vm = r.value.vm; break }
        why = String(r.value?.wait || r.value?.error || `HTTP ${r.status}`)
        if (r.status !== 503 || Date.now() > until) throw new Error(`no worker VM for ${name}: ${why}`)
        await sleep(10_000, exec.signal)
      }

      // The teammate's session, opened by that VM's dsh itself.
      const roster = [...state.rosters[team], { name, vm, session: '', role }]
      const r = await peer(vm, 'POST', '/idea-team/spawn', {
        team, name, role, task, lead: { vm: SELF, name: LEAD }, roster: roster.filter(m => m.session),
      }, exec.signal)
      if (r.status !== 200 || typeof r.value?.session !== 'string') {
        throw new Error(`${vm} could not start ${name}: ${r.value?.error ?? `HTTP ${r.status}`}`)
      }
      t.members.push({ name, vm, session: r.value.session, role })
      await broadcastRoster(team)
      await log({ team, from: LEAD, fromVm: SELF, to: name, toVm: vm, text: task, dir: 'out' })
      return { text: `Started ${name} on ${vm} (team ${team}). It will message you with team_send; its messages arrive as user messages.` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'team_send',
    description: 'Send a message straight to a teammate (or "all"), on whatever VM it runs. It reaches a working teammate at its next step, ' +
      'an idle one as a new turn. Use it to coordinate: interfaces, who changes which files, questions, results, being blocked.',
    parameters: {
      to: { type: 'string', required: true, description: 'Teammate name, "lead", or "all"' },
      text: { type: 'string', required: true, description: 'The message' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { to: string, text: string }, exec: any) {
      await load()
      const me = memberOf(exec)
      if (!me.local) throw new Error('this session is not in a team (team_spawn makes one)')
      const { team, name: from } = me.local
      const text = String(args.text).slice(0, MAX_TEXT)
      if (!text.trim()) throw new Error('empty message')
      const roster = state.rosters[team] ?? []
      const to = String(args.to).trim()
      const targets = to === 'all' ? roster.filter(m => m.name !== from) : roster.filter(m => m.name === to)
      if (targets.length === 0) throw new Error(`no teammate ${JSON.stringify(to)}; the team is:\n${rosterText(team, from)}`)
      const failed: string[] = []
      await Promise.all(targets.map(async m => {
        const payload = { team, from, fromVm: SELF, to: m.name, text }
        try {
          const r = m.vm === SELF ? await inbox(payload) : await peer(m.vm, 'POST', '/idea-team/inbox', payload, exec.signal)
          if (r.status !== 200) throw new Error(r.value?.error ?? `HTTP ${r.status}`)
          await log({ team, from, fromVm: SELF, to: m.name, toVm: m.vm, text, dir: 'out' })
        } catch (e) { failed.push(`${m.name}: ${(e as Error).message}`) }
      }))
      if (failed.length) throw new Error(`not delivered to ${failed.join('; ')}`)
      return { text: `Delivered to ${targets.map(m => m.name).join(', ')}.` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'team_list',
    description: 'List your team: each teammate, its role, its VM, and whether it is working right now.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args: unknown, exec: any) {
      await load()
      const me = memberOf(exec)
      if (!me.local) return { text: 'This session is not in a team (team_spawn makes one).' }
      const { team } = me.local
      const roster = state.rosters[team] ?? []
      const byVm = new Map<string, any[]>()
      await Promise.all([...new Set(roster.map(m => m.vm))].map(async vm => {
        try {
          const r = vm === SELF ? { status: 200, value: await load_() } : await peer(vm, 'GET', '/idea-team/load', undefined, exec.signal)
          if (r.status === 200) byVm.set(vm, r.value?.members ?? [])
        } catch { /* unreachable */ }
      }))
      const lines = roster.map(m => {
        const live = byVm.get(m.vm)?.find(x => x.team === team && x.name === m.name)
        const status = !byVm.has(m.vm) ? 'VM unreachable' : live?.stopped ? 'stopped' : live?.running ? 'working' : 'idle'
        return `- ${m.name}${m.session === me.session ? ' (you)' : ''}: ${m.role}; ${m.vm}; ${status}`
      })
      return { text: `Team ${team}:\n${lines.join('\n')}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'team_stop',
    description: 'Team lead only: stop a teammate (its current turn is cancelled and it takes no more messages). Its work in Forgejo stays.',
    parameters: {
      name: { type: 'string', required: true, description: 'Teammate name' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { name: string }, exec: any) {
      await load()
      const me = memberOf(exec)
      const t = me.local && state.led[me.local.team]
      if (!me.local || me.local.name !== LEAD || !t) throw new Error('only the team lead stops teammates')
      const m = t.members.find(x => x.name === args.name)
      if (!m) throw new Error(`no teammate ${JSON.stringify(args.name)}`)
      const r = await peer(m.vm, 'POST', '/idea-team/stop', { team: me.local.team, name: m.name }, exec.signal)
      if (r.status !== 200) throw new Error(`${m.vm}: ${r.value?.error ?? `HTTP ${r.status}`}`)
      return { text: `Stopped ${m.name}.` }
    },
  }))

  // ------------------------------------------------------------- peer API

  /** Local members and whether they are working (for team_list and the controller's slot count). */
  async function load_() {
    await load()
    const members = await Promise.all(Object.entries(state.local).map(async ([session, l]) => ({
      team: l.team, name: l.name, session,
      stopped: !!state.stopped[`${l.team}/${l.name}`],
      running: !!(await running(session)),
    })))
    return { vm: SELF, members }
  }

  async function inbox(v: any): Promise<Reply> {
    await load()
    if (!TEAM.test(v?.team) || !NAME.test(v?.from) || !NAME.test(v?.to) || !VM.test(v?.fromVm) || typeof v?.text !== 'string') {
      return { status: 400, value: { error: 'invalid message' } }
    }
    const hit = Object.entries(state.local).find(([, l]) => l.team === v.team && l.name === v.to)
    if (!hit) return { status: 404, value: { error: `${v.to} is not on ${SELF}` } }
    if (state.stopped[`${v.team}/${v.to}`]) return { status: 410, value: { error: `${v.to} was stopped` } }
    const text = `[team ${v.team}] message from ${v.from} (${v.fromVm}):\n\n${v.text.slice(0, MAX_TEXT)}\n\n` +
      `(Answer with team_send to "${v.from}" if it needs an answer.)`
    await deliver(hit[0], text)
    await log({ team: v.team, from: v.from, fromVm: v.fromVm, to: v.to, toVm: SELF, text: v.text.slice(0, MAX_TEXT), dir: 'in' })
    return { status: 200, value: { accepted: true } }
  }

  async function spawn(v: any): Promise<Reply> {
    await load()
    if (!TEAM.test(v?.team) || !NAME.test(v?.name) || !VM.test(v?.lead?.vm) || typeof v?.task !== 'string' || !Array.isArray(v?.roster)) {
      return { status: 400, value: { error: 'invalid spawn request' } }
    }
    const { team, name } = v
    if (Object.values(state.local).some(l => l.team === team && l.name === name)) {
      return { status: 409, value: { error: `${name} already runs here` } }
    }
    const dir = join(WORK_ROOT, team, name)
    await mkdir(dir, { recursive: true })
    const ws = await ctx.workspaceController.create({ path: dir })
    const created = await ctx.sessionController.create({ workspaceId: ws.workspace.workspaceId })
    const session: string = created.sessionId
    try { await ctx.sessionController.rename({ sessionId: session, title: `${name} · team ${team}` }) } catch { /* title only */ }
    state.local[session] = { team, name, lead: { vm: v.lead.vm, name: LEAD } }
    state.rosters[team] = (v.roster as Member[]).filter(m => NAME.test(m?.name) && VM.test(m?.vm))
      .concat([{ name, vm: SELF, session, role: String(v.role ?? '').slice(0, 200) }])
    await save()
    const intro = [
      `You are teammate "${name}" in team ${team} on the idea machine. You run on worker VM ${SELF}, a VM of your own.`,
      `Your role: ${String(v.role ?? '').slice(0, 200)}`,
      '',
      `The team lead is "lead" (on ${v.lead.vm}). Your teammates, each on its own VM:`,
      rosterText(team, name),
      '',
      'Talk to them directly with team_send (to a name, "lead", or "all"); their messages arrive here as user messages.',
      'Agree on interfaces and on who changes which files before you start, tell the others when something they depend on is ready,',
      'and send the lead a short report with team_send when you are done or blocked. team_list shows who is working.',
      'Deliver code as usual: clone the repository into this directory, work on a branch, open a pull request in Forgejo.',
      '',
      'Your task:',
      '',
      v.task.slice(0, MAX_TEXT),
    ].join('\n')
    await deliver(session, intro)
    await log({ team, from: LEAD, fromVm: v.lead.vm, to: name, toVm: SELF, text: v.task.slice(0, MAX_TEXT), dir: 'in' })
    return { status: 200, value: { session } }
  }

  async function roster(v: any): Promise<Reply> {
    await load()
    if (!TEAM.test(v?.team) || !Array.isArray(v?.roster)) return { status: 400, value: { error: 'invalid roster' } }
    const lead = Object.values(state.local).find(l => l.team === v.team)
    if (!lead) return { status: 404, value: { error: `no member of team ${v.team} on ${SELF}` } }
    state.rosters[v.team] = (v.roster as Member[]).filter(m => NAME.test(m?.name) && VM.test(m?.vm))
    await save()
    return { status: 200, value: { ok: true } }
  }

  async function stop(v: any): Promise<Reply> {
    await load()
    const hit = Object.entries(state.local).find(([, l]) => l.team === v?.team && l.name === v?.name)
    if (!hit) return { status: 404, value: { error: 'no such member here' } }
    state.stopped[`${v.team}/${v.name}`] = true
    await save()
    try { await ctx.sessionController.cancel({ sessionId: hit[0] }) } catch { /* not working */ }
    return { status: 200, value: { ok: true } }
  }

  async function readLog(team: string | null): Promise<LogLine[]> {
    let text = ''
    try { text = await readFile(logFile(), 'utf8') } catch { return [] }
    const out: LogLine[] = []
    for (const line of text.split('\n').slice(-2000)) {
      try { const v = JSON.parse(line); if (!team || v.team === team) out.push(v) } catch { /* partial line */ }
    }
    return out
  }

  const routes: Record<string, { method: string, handle: (v: any, req: IncomingMessage) => Promise<Reply> }> = {
    '/idea-team/inbox': { method: 'POST', handle: inbox },
    '/idea-team/spawn': { method: 'POST', handle: spawn },
    '/idea-team/roster': { method: 'POST', handle: roster },
    '/idea-team/stop': { method: 'POST', handle: stop },
    '/idea-team/load': { method: 'GET', handle: async () => ({ status: 200, value: await load_() }) },
  }

  for (const [path, route] of Object.entries(routes)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== route.method) { send(res, 405, { error: `${route.method} only` }); return }
        if (!(await hasTeamToken(req))) { res.statusCode = 401; res.end(); return }
        try {
          const v = route.method === 'POST' ? await body(req) : undefined
          const r = await route.handle(v, req)
          send(res, r.status, r.value)
        } catch (e) {
          const err = e as { status?: number, message?: string }
          if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : `failed: ${err.message ?? 'error'}` })
          else res.destroy()
        }
      },
    }), `idea: ${path}`)
  }

  // The conversation, for the owner's idea panel (signed in) or a peer.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/idea-team/log',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return }
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined && !(await hasTeamToken(req))) { res.statusCode = rejection; res.end(); return }
      const team = new URL(req.url || '/', 'http://x').searchParams.get('team')
      if (team !== null && !TEAM.test(team)) { send(res, 400, { error: 'invalid team' }); return }
      await load()
      send(res, 200, { vm: SELF, messages: await readLog(team), rosters: state.rosters })
    },
  }), 'idea: /idea-team/log')
}
