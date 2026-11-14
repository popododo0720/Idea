// idea-orchestrator: tools for the machine's orchestrator, the agent dsh
// where the owner plans work (idea-dsh).
//
// - `idea_project_create`: a new project (a repository in the machine's
//   Forgejo whose issues become tasks), empty or copied from a public Git
//   repository such as one on GitHub.
// - `idea_status`: projects, worker VMs and their load, tasks and their pull
//   requests.
// - `forgejo_issue_create`, `forgejo_issues`: open and list a project's
//   issues. Every open issue in a project becomes a task on a worker VM.
//
// Projects and status go through the controller's agent API (in-cluster port,
// the machine's team token; see controller/agentapi.go). Issues go to Forgejo
// with the bot's token, which stays in the dsh process: it never appears in
// tool arguments, results or logs.
//
// Worker VMs load this plugin too, but get no tools from it: a worker that
// opened issues would start more tasks on its own.

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'idea-orchestrator'
export const inject = ['tools']

const SELF = process.env.IDEA_VM || 'idea-dsh'
const TOKEN_FILE = process.env.IDEA_TEAM_TOKEN_FILE || '/etc/idea/team/token'
const CONTROLLER = (process.env.IDEA_CONTROLLER || 'http://idea-controller.idea-system.svc:8080').replace(/\/+$/, '')
const FORGEJO_API = (process.env.FORGEJO_API || '').replace(/\/+$/, '')
const FORGEJO_TOKEN_FILE = '/etc/idea/forgejo/token'

const PROJECT = /^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$/
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const IMPORT = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/-]+$/
const MAX_BODY = 1024 * 1024

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

async function secret(file: string, env?: string): Promise<string> {
  try {
    const t = (await readFile(file, 'utf8')).trim()
    if (t) return t
  } catch { /* fall back */ }
  return (env && process.env[env]) || ''
}

/** One JSON request to the controller's agent API. */
async function controller(method: string, path: string, payload?: unknown, signal?: AbortSignal): Promise<{ status: number, value: any }> {
  const token = await secret(TOKEN_FILE)
  if (!token) throw new Error('this machine has no team token yet (Secret idea-team); try again in a minute')
  const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(CONTROLLER + path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
      },
      timeout: 60_000,
      signal,
    }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c) })
      res.on('end', () => {
        let value: any = null
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, value })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('the controller did not answer')))
    req.on('error', reject)
    req.end(data)
  })
}

async function forgejo(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const token = await secret(FORGEJO_TOKEN_FILE, 'FORGEJO_TOKEN')
  if (!FORGEJO_API || !token) throw new Error('Forgejo is not configured in this dsh')
  const res = await fetch(FORGEJO_API + path, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `token ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Forgejo ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

function errorOf(r: { status: number, value: any }): string {
  return String(r.value?.error ?? `HTTP ${r.status}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any) {
  if (SELF !== 'idea-dsh') return

  ctx.tools.register(defineTool({
    name: 'idea_project_create',
    description: 'Create a project on this machine: a repository in the machine\'s Forgejo whose open issues become tasks on worker VMs. ' +
      'Empty, or copied once (code and history) from a public Git repository such as https://github.com/owner/repo.git. ' +
      'The repository is ready within about a minute; check with idea_status.',
    parameters: {
      name: { type: 'string', required: true, description: 'Project and repository name: lowercase letters, digits, dashes' },
      description: { type: 'string', required: false, description: 'One line about the project' },
      import_url: { type: 'string', required: false, description: 'Public https Git URL to copy the code from (optional)' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { name: string, description?: string, import_url?: string }, exec: any) {
      const name = String(args.name).trim().toLowerCase()
      if (!PROJECT.test(name)) throw new Error('name: lowercase letters, digits and dashes, up to 40 characters')
      const from = String(args.import_url ?? '').trim()
      if (from && !IMPORT.test(from)) throw new Error('import_url: a public https Git URL without credentials')
      const r = await controller('POST', '/agent/projects', {
        name, description: String(args.description ?? '').slice(0, 500), import: from,
      }, exec?.signal)
      if (r.status !== 201) throw new Error(`could not create project ${name}: ${errorOf(r)}`)
      const p = r.value
      return {
        text: `Project ${p.name} created: repository ${p.repo}${from ? `, copied from ${from}` : ''}. ` +
          `It is being set up; idea_status shows when it is ready. Open issues in ${p.repo} with forgejo_issue_create.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'idea_status',
    description: 'The machine\'s state: projects (and whether each repository is ready), worker VMs with their load, ' +
      'and tasks (one per open issue) with their phase, VM and pull request.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args: unknown, exec: any) {
      const r = await controller('GET', '/agent/status', undefined, exec?.signal)
      if (r.status !== 200) throw new Error(`status: ${errorOf(r)}`)
      const v = r.value
      const lines: string[] = ['Projects:']
      for (const p of v.projects ?? []) {
        lines.push(`- ${p.name} (${p.repo}): ${p.ready ? 'ready' : `not ready${p.message ? `: ${p.message}` : ''}`}`)
      }
      if (!(v.projects ?? []).length) lines.push('- (none; idea_project_create makes one)')
      lines.push('', `Worker VMs (${v.workerSlots} sessions each, at most ${v.maxWorkers} VMs):`)
      for (const w of v.workers ?? []) lines.push(`- ${w.name}: ${w.phase}, ${w.active} working`)
      if (!(v.workers ?? []).length) lines.push('- (none running; they start when there is work)')
      if (v.note) lines.push(`  note: ${v.note}`)
      lines.push('', 'Tasks:')
      const tasks = (v.tasks ?? []).slice(0, 100)
      for (const t of tasks) {
        lines.push(`- ${t.project}#${t.issue} ${t.title}: ${t.phase}${t.vm ? ` on ${t.vm}` : ''}` +
          `${t.pullRequest ? `, PR #${t.pullRequest}` : ''}${t.message ? ` (${t.message})` : ''}`)
      }
      if (!tasks.length) lines.push('- (none)')
      return { text: lines.join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forgejo_issue_create',
    description: 'Open an issue in a project repository of this machine. Every open issue becomes a task: an agent on a worker VM ' +
      'works on it and opens a pull request, which is tested and merged. Write one independent piece of work per issue, ' +
      'with acceptance criteria and the tests to add.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name (see idea_status)' },
      title: { type: 'string', required: true, description: 'Issue title' },
      body: { type: 'string', required: true, description: 'What to do, what done means, tests to add (Markdown)' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { repo: string, title: string, body: string }, exec: any) {
      if (!REPO.test(args.repo)) throw new Error('repo: owner/name')
      const title = String(args.title).trim().slice(0, 250)
      if (!title) throw new Error('empty title')
      const issue = await forgejo('POST', `/repos/${args.repo}/issues`, {
        title, body: String(args.body ?? '').slice(0, 60_000),
      }, exec?.signal)
      return { text: `Opened ${args.repo}#${issue.number}: ${issue.title}\n${issue.html_url ?? ''}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forgejo_issues',
    description: 'List issues of a project repository (open by default).',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name' },
      state: { type: 'string', required: false, description: '"open" (default), "closed" or "all"' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { repo: string, state?: string }, exec: any) {
      if (!REPO.test(args.repo)) throw new Error('repo: owner/name')
      const state = ['open', 'closed', 'all'].includes(String(args.state)) ? String(args.state) : 'open'
      const list: any[] = await forgejo('GET', `/repos/${args.repo}/issues?state=${state}&type=issues&limit=50`, undefined, exec?.signal)
      const lines = list.map(i => `- #${i.number} [${i.state}] ${i.title}`)
      return { text: lines.length ? lines.join('\n') : `No ${state} issues in ${args.repo}.` }
    },
  }))
}
