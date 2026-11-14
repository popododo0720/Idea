// idea: update notice and one-click update.
//
// The installed version is this package's own package.json. The latest is the
// same file on the default branch of the GitHub repository the plugin was
// installed from. Nothing is installed unless the owner clicks Update; then
// the same command the owner would type runs, without a shell:
//   dsh plugin --profile <profile> add "<installed spec>"

import { execFile as nodeExecFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const DEFAULT_SPEC = 'github:popododo0720/Idea#path:/plugins/idea'
const DEFAULT_REPO = { owner: 'popododo0720', repo: 'Idea', ref: 'main', dir: 'plugins/idea' }
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
export const MIN_GAP_MS = 10 * 60 * 1000
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
const VERSION = /^\d+\.\d+\.\d+$/
const STDERR_LINES = 8

export const isVersion = v => typeof v === 'string' && VERSION.test(v)

/** 1 when a is newer than b, -1 when older, 0 when equal; numeric per part. */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  }
  return 0
}

/** owner/repo/ref/dir from an installed spec, or the default repository. */
export function repoOf(spec) {
  const m = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/.exec(typeof spec === 'string' ? spec : '')
  if (!m) return { ...DEFAULT_REPO }
  const out = { owner: m[1], repo: m[2], ref: DEFAULT_REPO.ref, dir: '' }
  for (const part of (m[3] || '').split('&')) {
    const p = /^path:\/?(.*)$/.exec(part)
    if (p) out.dir = p[1].replace(/\/+$/, '')
    else if (/^[A-Za-z0-9_./-]+$/.test(part) && !part.includes('..')) out.ref = part
  }
  return out
}

export const rawUrl = r => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${r.dir ? r.dir + '/' : ''}package.json`
export const commitsUrl = r => `https://github.com/${r.owner}/${r.repo}/commits/${r.ref}`

/**
 * The argument list that runs `dsh plugin --profile <p> add <spec>` with the
 * running dsh: its Node and script, or its own executable when it is a single
 * binary. Returns undefined when the profile is unknown.
 */
export function updateCommand({ env, argv, execPath, spec }) {
  const profile = env.DSH_PROFILE || (env.DSH_PROFILE_DIR ? env.DSH_PROFILE_DIR.split('/').filter(Boolean).pop() : '')
  if (!profile) return undefined
  const rest = ['plugin', '--profile', profile, 'add', spec]
  if (env.DSH_NODE_EXECUTABLE && argv[1]) return { file: env.DSH_NODE_EXECUTABLE, args: [argv[1], ...rest] }
  return { file: execPath, args: rest }
}

function installedVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

export function createUpdater({
  ctx,
  fetchImpl = (...a) => globalThis.fetch(...a),
  execFile = nodeExecFile,
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  now = () => Date.now(),
  installed = installedVersion(),
  source = async () => undefined,
}) {
  let latest
  let lastCheck = -Infinity
  let warned = false
  let running = false
  let result
  let spec = DEFAULT_SPEC
  let repo = repoOf(spec)

  const specNow = async () => {
    let s
    try { s = await source() } catch { /* dsh does not say */ }
    if (typeof s === 'string' && s) { spec = s; repo = repoOf(s) }
    return spec
  }

  const check = async () => {
    if (now() - lastCheck < MIN_GAP_MS) return
    lastCheck = now()
    await specNow()
    try {
      const res = await fetchImpl(rawUrl(repo), { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const v = JSON.parse(await res.text()).version
      if (isVersion(v)) latest = v
    } catch (e) {
      if (!warned) { warned = true; ctx.logger.warn('idea: update check failed: %s', e && e.message) }
    }
  }

  const state = () => ({
    installed,
    latest: latest || null,
    available: Boolean(latest) && compareVersions(latest, installed) > 0,
    commits: commitsUrl(repo),
    running,
    result: result || null,
  })

  const apply = () => new Promise(resolve => {
    if (running) { resolve({ ok: false, error: 'An update is already running.' }); return }
    const cmd = updateCommand({ env, argv, execPath, spec })
    if (!cmd) { result = { ok: false, code: null, stderr: 'The dsh profile is unknown.' }; resolve(result); return }
    running = true
    execFile(cmd.file, cmd.args, { timeout: UPDATE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      running = false
      if (!err) result = { ok: true }
      else {
        const lines = String(stderr || err.message || '').trim().split('\n').slice(-STDERR_LINES).join('\n')
        result = { ok: false, code: typeof err.code === 'number' ? err.code : null, stderr: lines }
      }
      resolve(result)
    })
  })

  const timers = { start: undefined, every: undefined }
  const start = () => {
    timers.start = setTimeout(() => { check() }, 5_000)
    timers.every = setInterval(() => { check() }, CHECK_EVERY_MS)
  }
  const stop = () => { clearTimeout(timers.start); clearInterval(timers.every) }

  return { check, state, apply, start, stop, specNow }
}
