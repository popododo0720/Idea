// idea worker-ssh: a dsh plugin for the main agent.
//
// It adds one tool, `worker_run`, that hands a task to a work VM: it opens an
// SSH session to the work pod and runs `dsh headless --json` there, so the
// agent loop, the browser and the files all live inside the VM. The main
// agent only sees the outcome.
//
// The task travels on stdin (never on a command line), and the event stream
// of the remote run is kept in a file so a human can read what happened.

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'idea-worker-ssh'
export const inject = ['tools']

export interface Config {
  /** Private key used to log in to work pods. */
  identityFile?: string
  /** DNS suffix appended to a worker name, e.g. ".idea-work.svc". */
  hostSuffix?: string
  port?: number
  user?: string
  /** Where the event stream of every run is written. */
  logDir?: string
  /** dsh profile to run on the worker. */
  profile?: string
}

const WORKER_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

interface RunResult {
  completed: boolean
  exitCode: number
  answer: string
  toolCalls: number
  sessionId: string
  logFile: string
}

export function apply(ctx: Context, config: Config = {}) {
  const identityFile = config.identityFile ?? '/etc/idea/ssh/privateKey'
  const hostSuffix = config.hostSuffix ?? '.idea-work.svc'
  const port = config.port ?? 2222
  const user = config.user ?? 'idea'
  const logDir = config.logDir ?? '/tmp/idea-runs'
  const profile = config.profile ?? 'headless'

  ctx.tools.register(defineTool({
    name: 'worker_run',
    description:
      'Hand a task to a work VM and wait for the result. The task runs there as an ' +
      'autonomous coding agent with a shell, git, Node.js and a Chrome browser. ' +
      'Give a complete, self-contained instruction; the worker does not see this conversation.',
    parameters: {
      worker: { type: 'string', required: true, description: 'Name of the work VM, e.g. "w1"' },
      task: { type: 'string', required: true, description: 'Complete instructions for the worker' },
      timeoutSeconds: { type: 'number', description: 'Give up after this long (default 900)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          completed: { type: 'boolean', required: true },
          exitCode: { type: 'number', required: true },
          answer: { type: 'string', required: true },
          toolCalls: { type: 'number', required: true },
          sessionId: { type: 'string', required: true },
          logFile: { type: 'string', required: true },
        },
      },
      render: (_args, v: RunResult) => [{
        type: 'text',
        text:
          `worker run ${v.completed ? 'completed' : 'DID NOT complete'} ` +
          `(exit ${v.exitCode}, ${v.toolCalls} tool calls, session ${v.sessionId || 'unknown'})\n` +
          `log: ${v.logFile}\n\n${v.answer}`,
      }],
    },
    async execute(args, exec): Promise<RunResult> {
      if (!WORKER_NAME.test(args.worker)) {
        throw new Error(`invalid worker name: ${JSON.stringify(args.worker)}`)
      }
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const logFile = join(logDir, `${args.worker}-${Date.now()}.jsonl`)
      const log = createWriteStream(logFile, { mode: 0o600 })

      // The remote side loads the pod's own environment (model keys, DISPLAY)
      // and reads the task from stdin ("-").
      const remote =
        `. /tmp/idea/env && cd "$HOME/work" && ` +
        `exec dsh --profile ${profile} --json --approval-policy never -`

      const child = spawn('ssh', [
        '-i', identityFile,
        '-p', String(port),
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30',
        // Work pods create a fresh host key at every start, so there is no
        // stable key to pin. The connection never leaves the cluster network.
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        `${user}@${args.worker}${hostSuffix}`,
        remote,
      ], { stdio: ['pipe', 'pipe', 'pipe'] })

      const timeoutMs = Math.max(10, args.timeoutSeconds ?? 900) * 1000
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      const onAbort = () => child.kill('SIGTERM')
      exec.signal.addEventListener('abort', onAbort, { once: true })

      child.stdin.end(args.task)

      let buffer = ''
      let answer = ''
      let sessionId = ''
      let toolCalls = 0
      let completed = false
      let stderrTail = ''

      const onLine = (line: string) => {
        if (!line.trim()) return
        log.write(line + '\n')
        let event: any
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
        if (event.type === 'tool_call') toolCalls += 1
        if (event.type === 'final') {
          answer = typeof event.text === 'string' ? event.text : ''
          completed = event.reason?.kind === 'completed'
          if (typeof event.sessionId === 'string') sessionId = event.sessionId
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let i: number
        while ((i = buffer.indexOf('\n')) >= 0) {
          onLine(buffer.slice(0, i))
          buffer = buffer.slice(i + 1)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
      })

      const exitCode: number = await new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 255))
      })
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', onAbort)
      if (buffer) onLine(buffer)
      await new Promise<void>((resolve) => log.end(resolve))

      if (!answer && exitCode !== 0) {
        answer = `The worker run failed before producing an answer.\n${stderrTail.trim()}`
      }
      return { completed: completed && exitCode === 0, exitCode, answer, toolCalls, sessionId, logFile }
    },
  }))
}
