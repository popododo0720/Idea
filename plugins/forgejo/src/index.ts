// idea forgejo: a dsh plugin that lets an agent work with the machine's
// Forgejo (issues, pull requests, commit checks).
//
// The Forgejo address and token come from the environment of the dsh
// process (FORGEJO_API, FORGEJO_TOKEN). The token is sent in a header only;
// it never appears in tool arguments, results or logs.

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'idea-forgejo'
export const inject = ['tools']

export interface Config {
  /** Forgejo API root, e.g. http://forgejo-http.idea-system.svc:3000/api/v1 */
  api?: string
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/
const MAX_TEXT = 60_000

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s
}

export function apply(ctx: Context, config: Config = {}) {
  const api = (config.api ?? process.env.FORGEJO_API ?? '').replace(/\/+$/, '')

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const token = process.env.FORGEJO_TOKEN
    if (!api || !token) throw new Error('Forgejo is not configured in this dsh (FORGEJO_API / FORGEJO_TOKEN)')
    const res = await fetch(api + path, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `token ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Forgejo ${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  function repoOf(repo: string): string {
    if (!REPO.test(repo)) throw new Error(`invalid repository ${JSON.stringify(repo)}; expected owner/name`)
    return repo
  }

  ctx.tools.register(defineTool({
    name: 'forgejo_issue',
    description: 'Read a Forgejo issue (or pull request) with its comments.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name' },
      number: { type: 'number', required: true, description: 'Issue number' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const repo = repoOf(args.repo)
      const n = Math.trunc(args.number)
      const issue = await call('GET', `/repos/${repo}/issues/${n}`)
      const comments: any[] = await call('GET', `/repos/${repo}/issues/${n}/comments?limit=50`)
      const lines = [
        `#${issue.number} ${issue.title} [${issue.state}] by ${issue.user?.login ?? '?'}`,
        issue.html_url ?? '',
        '',
        issue.body || '(no description)',
      ]
      for (const c of comments) lines.push('', `--- ${c.user?.login ?? '?'} at ${c.created_at}`, c.body ?? '')
      return { text: clip(lines.join('\n')) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forgejo_pull_request',
    description:
      'Open a pull request from a pushed branch, or return the open one that already exists for it. ' +
      'Push the branch first.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name' },
      head: { type: 'string', required: true, description: 'Branch with the changes' },
      title: { type: 'string', required: true, description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request description, e.g. "Closes #12"' },
      base: { type: 'string', description: 'Target branch (default main)' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const repo = repoOf(args.repo)
      const base = args.base ?? 'main'
      if (!BRANCH.test(args.head) || !BRANCH.test(base)) throw new Error('invalid branch name')
      const open: any[] = await call('GET', `/repos/${repo}/pulls?state=open&limit=50`)
      const existing = open.find(p => p.head?.ref === args.head)
      if (existing) return { text: `pull request #${existing.number} already open: ${existing.html_url}` }
      const pr = await call('POST', `/repos/${repo}/pulls`, {
        head: args.head, base, title: args.title, body: args.body ?? '',
      })
      return { text: `pull request #${pr.number} opened: ${pr.html_url}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forgejo_comment',
    description: 'Add a comment to a Forgejo issue or pull request.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name' },
      number: { type: 'number', required: true, description: 'Issue or pull request number' },
      body: { type: 'string', required: true, description: 'Comment text (Markdown)' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const repo = repoOf(args.repo)
      const c = await call('POST', `/repos/${repo}/issues/${Math.trunc(args.number)}/comments`, { body: args.body })
      return { text: `comment added: ${c.html_url ?? ''}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forgejo_checks',
    description: 'Show the combined commit status (test results) for a branch or commit.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository as owner/name' },
      ref: { type: 'string', required: true, description: 'Branch name or commit SHA' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const repo = repoOf(args.repo)
      if (!BRANCH.test(args.ref)) throw new Error('invalid ref')
      const st = await call('GET', `/repos/${repo}/commits/${encodeURIComponent(args.ref)}/status`)
      const lines = [`combined state: ${st.state || 'none'} (${st.total_count ?? 0} checks)`]
      for (const s of st.statuses ?? []) lines.push(`- ${s.context}: ${s.status ?? s.state} ${s.description ?? ''}`)
      return { text: lines.join('\n') }
    },
  }))
}
