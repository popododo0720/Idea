// The Team tab's data: the agent teams on the machine, what each member is
// doing, and the messages between them.
//
// Every VM keeps a log of the team messages it sent and received
// (plugins/team, GET /idea-team/log). This reads those logs through the view
// proxies (signed in to each VM's dsh as the owner), keeps one copy of each
// message, and asks each member's dsh whether its session is working.

const LOG_PATH = '/idea-team/log?limit=300&max=4000'
const TIMEOUT_MS = 15_000
const MAX_MESSAGES = 300
const MAX_TEAMS = 12

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * A message is in the sender's log (dir "out") and in the receiver's ("in").
 * Keep the sender's copy, and the receiver's only when the sender's is
 * missing (its VM did not answer).
 */
export function mergeMessages(logs) {
  const groups = new Map()
  for (const l of logs) {
    for (const m of (l && l.messages) || []) {
      if (!m || typeof m.text !== 'string' || typeof m.team !== 'string') continue
      const key = [m.team, m.from, m.fromVm, m.to, m.text].join('\u0000')
      let g = groups.get(key)
      if (!g) groups.set(key, g = { out: [], in: [] })
      ;(m.dir === 'in' ? g.in : g.out).push(m)
    }
  }
  const out = []
  for (const g of groups.values()) out.push(...g.out, ...g.in.slice(g.out.length))
  out.sort((a, b) => String(a.t).localeCompare(String(b.t)))
  return out.slice(-MAX_MESSAGES)
}

/**
 * Teams from the rosters (the lead's VM, idea-dsh, has the one the lead
 * last sent; the others have copies), newest activity first, with each
 * member's last message. Agents that took part in the conversation but are
 * no longer in the roster were stopped by the lead.
 */
export function teamsOf(logs, messages) {
  const rosters = {}
  const ordered = [...logs].filter(Boolean).sort((a, b) => (a.vm === 'idea-dsh') - (b.vm === 'idea-dsh'))
  for (const l of ordered) Object.assign(rosters, l.rosters || {})
  const lastOfTeam = {}
  const lastFrom = {}
  for (const m of messages) {
    lastOfTeam[m.team] = m.t
    lastFrom[`${m.team}/${m.from}`] = m
  }
  const seen = {}
  for (const m of messages) {
    const list = seen[m.team] ??= new Map()
    if (!list.has(m.from)) list.set(m.from, m.fromVm)
    if (m.to !== 'all' && !list.has(m.to)) list.set(m.to, m.toVm)
  }
  const member = (team, m, stopped) => {
    const said = lastFrom[`${team}/${m.name}`]
    return {
      name: String(m.name), role: String(m.role || ''), vm: String(m.vm || ''), session: stopped ? '' : String(m.session || ''),
      lastAt: said ? said.t : '', lastText: said ? said.text.slice(0, 300) : '', ...(stopped ? { status: 'stopped' } : {}),
    }
  }
  const teams = Object.entries(rosters)
    .filter(([, members]) => Array.isArray(members))
    .map(([team, members]) => {
      const names = new Set(members.map(m => m.name))
      const gone = [...(seen[team] ?? new Map())].filter(([name]) => name && !names.has(name)).map(([name, vm]) => ({ name, vm }))
      return {
        team,
        last: lastOfTeam[team] || '',
        members: [...members.map(m => member(team, m, false)), ...gone.map(m => member(team, m, true))],
      }
    })
    .sort((a, b) => String(b.last).localeCompare(String(a.last)))
  return { teams: teams.slice(0, MAX_TEAMS), older: Math.max(0, teams.length - MAX_TEAMS) }
}

/**
 * @param {object} opts
 * @param {string[]} opts.workers  worker VMs that are up
 * @param {(vm: string) => {json: Function, rpc: Function}} opts.viewOf  "" is idea-dsh
 */
export async function teamView({ workers, viewOf }) {
  const vms = ['idea-dsh', ...workers]
  const viewFor = vm => viewOf(vm === 'idea-dsh' ? '' : vm)
  const errors = []
  const logs = await Promise.all(vms.map(async vm => {
    try {
      const r = await withTimeout(viewFor(vm).json('GET', LOG_PATH), TIMEOUT_MS, vm)
      if (r.status === 404) return null // the team plugin is not on this VM
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const v = JSON.parse(r.text)
      return { ...v, vm }
    } catch (e) {
      errors.push({ vm, error: String((e && e.message) || e) })
      return null
    }
  }))
  const messages = mergeMessages(logs)
  const { teams, older } = teamsOf(logs, messages)

  // Working or idle, from each member's own dsh.
  const up = new Set(vms.filter((_, i) => logs[i]))
  await Promise.all(teams.flatMap(t => t.members.map(async m => {
    if (m.status === 'stopped') return
    if (!m.session || !up.has(m.vm)) { m.status = 'unknown'; return }
    try {
      const s = await withTimeout(viewFor(m.vm).rpc('session/state', { request: { sessionId: m.session } }), TIMEOUT_MS, m.vm)
      m.status = s && s.running ? 'working' : 'idle'
    } catch {
      m.status = 'unknown'
    }
  })))
  return { teams, older, messages, errors }
}
