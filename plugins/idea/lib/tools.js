// idea: agent tools for the owner's dsh. They let the agent in this dsh hand
// work to the paired machine and read its progress, through the same pinned
// connection and device token the panel uses. The token stays in index.js;
// `ask` is all this module gets.

import { defineTool } from '@deepseek-ai/dsh-tools'

const PROJECT = /^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$/
const MAX_TITLE = 200
const MAX_BODY = 20000
export const NOT_PAIRED = 'not paired with an idea machine: open the idea panel in dsh and pair it first'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true } },
  },
  render: (_args, v) => [{ type: 'text', text: v.text }],
}

const unpaired = () => ({ ok: false, text: `Error: ${NOT_PAIRED}.` })

function errorOf(r) {
  const e = r.value && typeof r.value === 'object' ? r.value.error : undefined
  return typeof e === 'string' && e ? e : `HTTP ${r.status}`
}

function line(t) {
  const bits = [`${t.project}#${t.issue} ${t.title}`, t.phase]
  if (t.pullRequest) bits.push(`PR #${t.pullRequest}`)
  if (t.message) bits.push(String(t.message))
  return bits.join(' | ')
}

/**
 * @param {{ ask: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<{status: number, value: any} | undefined> }} deps
 *   `ask` answers undefined when this dsh is not paired.
 */
export function createTools({ ask }) {
  const status = async signal => {
    const r = await ask('GET', '/api/v1/status', undefined, signal)
    if (!r) return undefined
    if (r.status !== 200) throw new Error(`the machine refused: ${errorOf(r)}`)
    return r.value && typeof r.value === 'object' ? r.value : {}
  }

  const create = defineTool({
    name: 'idea_task_create',
    description: 'Hand a piece of work to the idea machine: it becomes an issue in the project\'s repository and a task that ' +
      'a different agent on a worker VM does, from that text alone. That agent sees nothing of this conversation, so write a complete ' +
      'issue body: the goal, what to change (files, behavior), and acceptance criteria it can check. A vague body gives a vague result. ' +
      'Use idea_projects to pick the project and idea_tasks to follow the progress.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name, as idea_projects lists it' },
      title: { type: 'string', required: true, description: 'One-line issue title, up to 200 characters' },
      body: { type: 'string', required: true, description: 'Complete issue body: goal, what to change, acceptance criteria. Up to 20000 characters' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const project = String(args.project ?? '').trim()
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '')
      if (!PROJECT.test(project)) throw new Error('project: a project name (lowercase letters, digits, dashes); idea_projects lists them')
      if (!title) throw new Error('title: required')
      if (Buffer.byteLength(title) > MAX_TITLE) throw new Error(`title: up to ${MAX_TITLE} characters`)
      if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`body: up to ${MAX_BODY} characters`)
      const r = await ask('POST', '/api/v1/tasks', { project, title, body }, exec?.signal)
      if (!r) return unpaired()
      if (r.status !== 201 && r.status !== 200) throw new Error(`the machine refused the task: ${errorOf(r)}`)
      const v = r.value || {}
      return { ok: true, text: `Task created in project ${v.project ?? project}: issue #${v.issue}, task ${v.task}. idea_tasks shows its progress.` }
    },
  })

  const tasks = defineTool({
    name: 'idea_tasks',
    description: 'List the idea machine\'s tasks with their phase, pull request and last message, to report progress on work handed over with idea_task_create.',
    parameters: {
      project: { type: 'string', description: 'Only this project (optional)' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const project = String(args.project ?? '').trim()
      if (project && !PROJECT.test(project)) throw new Error('project: a project name')
      const s = await status(exec?.signal)
      if (!s) return unpaired()
      const list = (Array.isArray(s.tasks) ? s.tasks : []).filter(t => t && (!project || t.project === project))
      return { ok: true, text: list.length ? list.map(line).join('\n') : 'No tasks.' }
    },
  })

  const projects = defineTool({
    name: 'idea_projects',
    description: 'List the idea machine\'s projects, to pick the one for idea_task_create.',
    parameters: {},
    output: OUTPUT,
    async execute(_args, exec) {
      const s = await status(exec?.signal)
      if (!s) return unpaired()
      const list = (Array.isArray(s.projects) ? s.projects : []).filter(p => p && p.name)
      return {
        ok: true,
        text: list.length
          ? list.map(p => `${p.name}${p.ready === false ? ' (not ready yet)' : ''}${p.message ? ` | ${p.message}` : ''}`).join('\n')
          : 'No projects.',
      }
    },
  })

  return [create, tasks, projects]
}
