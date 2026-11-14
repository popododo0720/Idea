// The Git tab's local half: the git repositories of this dsh's workspaces
// (folders on this computer), read and changed with the `git` on PATH.
//
// The panel names a repository by its workspace id, never by a path; every
// command is a fixed argument list (no shell), names are checked before they
// reach git, and paths always come after `--`. Network commands (fetch,
// pull, push) use the person's own git credentials and never prompt.

import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve as resolvePath, relative, isAbsolute } from 'node:path'

const MAX_OUTPUT = 16 * 1024 * 1024
const MAX_DIFF = 2 * 1024 * 1024
const LOCAL_MS = 30_000
const NETWORK_MS = 120_000

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/
const SHA = /^[0-9a-f]{4,64}$/
const STASH = /^stash@\{\d{1,4}\}$/

function bad(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** Run git in `cwd`; resolves { code, out, err }. */
export function git(cwd, args, { timeout = LOCAL_MS, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      if (error && !okCodes.includes(code)) {
        const msg = String(stderr || error.message).trim().split('\n').slice(-6).join('\n')
        reject(Object.assign(new Error(msg || `git ${args[0]} failed`), { status: 409 }))
        return
      }
      resolve({ code, out: String(stdout), err: String(stderr) })
    })
  })
}

/** `git status --porcelain=v2 --branch -z`, parsed. */
export function parseStatus(text) {
  const head = { branch: '', upstream: '', ahead: 0, behind: 0, oid: '' }
  const files = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# branch.head ')) head.branch = p.slice(14)
    else if (p.startsWith('# branch.oid ')) head.oid = p.slice(13)
    else if (p.startsWith('# branch.upstream ')) head.upstream = p.slice(18)
    else if (p.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(p)
      if (m) { head.ahead = Number(m[1]); head.behind = Number(m[2]) }
    } else if (p[0] === '1' || p[0] === '2') {
      const f = p.split(' ')
      const xy = f[1]
      const path = f.slice(p[0] === '1' ? 8 : 9).join(' ')
      const from = p[0] === '2' ? parts[++i] : ''
      files.push({ path, from, x: xy[0], y: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false, conflict: false })
    } else if (p[0] === 'u') {
      const f = p.split(' ')
      files.push({ path: f.slice(10).join(' '), from: '', x: 'U', y: 'U', staged: false, unstaged: true, untracked: false, conflict: true })
    } else if (p[0] === '?') {
      files.push({ path: p.slice(2), from: '', x: '?', y: '?', staged: false, unstaged: true, untracked: true, conflict: false })
    }
  }
  return { head, files }
}

const SEP = '\x1f'
const REC = '\x1e'

export function parseLog(text) {
  return text.split(REC).map(r => r.replace(/^\n/, '')).filter(Boolean).map(r => {
    const [sha, short, author, date, subject, refs] = r.split(SEP)
    return { sha, short, author, date, subject, refs: (refs || '').trim() }
  })
}

/** A new (untracked) file shown as a diff; read here, so it works the same on Windows. */
export async function newFileDiff(root, path) {
  const full = resolvePath(root, path)
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw bad('invalid path')
  const realRoot = await realpath(root)
  const realRel = relative(realRoot, await realpath(full))
  if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) throw bad('invalid path')
  const st = await stat(full)
  if (!st.isFile()) return { diff: `new ${st.isDirectory() ? 'directory' : 'entry'}: ${path}\n`, clipped: false }
  const buf = await readFile(full)
  if (buf.subarray(0, 8000).includes(0)) return { diff: `new file: ${path}\nBinary file (${st.size} bytes)\n`, clipped: false }
  const lines = buf.toString('utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return clipDiff(`new file: ${path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => '+' + l).join('\n') + '\n')
}

function clipDiff(text) {
  return text.length > MAX_DIFF ? { diff: text.slice(0, MAX_DIFF), clipped: true } : { diff: text, clipped: false }
}

/**
 * @param {object} opts
 * @param {() => Array<{id: string, title: string, path: string}>} opts.workspaces  this dsh's workspaces
 */
export function createLocalGit({ workspaces }) {
  // workspace id -> repository root, checked again when it is not known yet.
  const roots = new Map()

  async function rootOf(workspaceId) {
    const ws = workspaces().find(w => w.id === workspaceId)
    if (!ws) throw Object.assign(new Error('no such workspace'), { status: 404 })
    let root = roots.get(ws.id)
    if (!root) {
      const r = await git(ws.path, ['rev-parse', '--show-toplevel']).catch(() => undefined)
      if (!r) throw Object.assign(new Error(`${ws.title} is not a git repository`), { status: 404 })
      root = r.out.trim()
      roots.set(ws.id, root)
    }
    return root
  }

  async function repos() {
    const list = []
    await Promise.all(workspaces().map(async w => {
      const r = await git(w.path, ['rev-parse', '--show-toplevel'], { timeout: 10_000 }).catch(() => undefined)
      if (r) {
        roots.set(w.id, r.out.trim())
        list.push({ id: w.id, title: w.title, root: r.out.trim() })
      }
    }))
    return list.sort((a, b) => a.title.localeCompare(b.title))
  }

  async function state(id) {
    const root = await rootOf(id)
    const [st, refs, stash] = await Promise.all([
      git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      git(root, ['for-each-ref', `--format=%(refname)${SEP}%(refname:short)${SEP}%(objectname:short)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(HEAD)${SEP}%(committerdate:iso-strict)${SEP}%(subject)`, 'refs/heads', 'refs/remotes']),
      git(root, ['stash', 'list', `--format=%gd${SEP}%gs${SEP}%cI`]),
    ])
    const { head, files } = parseStatus(st.out)
    const branches = refs.out.split('\n').filter(Boolean).map(l => {
      const [ref, name, sha, upstream, track, current, date, subject] = l.split(SEP)
      return { name, sha, upstream, track, current: current === '*', remote: ref.startsWith('refs/remotes/'), date, subject }
    }).filter(b => !(b.remote && b.name.endsWith('/HEAD')))
    const stashes = stash.out.split('\n').filter(Boolean).map(l => {
      const [ref, subject, date] = l.split(SEP)
      return { ref, subject, date }
    })
    return { root, head, files: files.slice(0, 2000), more: Math.max(0, files.length - 2000), branches, stashes }
  }

  async function log(id, ref) {
    const root = await rootOf(id)
    if (ref && !BRANCH.test(ref) && !SHA.test(ref)) throw bad('invalid branch')
    const r = await git(root, ['log', '-n', '300', `--format=${REC}%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s${SEP}%D`, ...(ref ? [ref, '--'] : ['--'])], { okCodes: [0, 128] })
    return { commits: parseLog(r.out) }
  }

  async function diff(id, q) {
    const root = await rootOf(id)
    if (q.kind === 'file') {
      const path = String(q.path || '')
      if (!path || path.startsWith('-')) throw bad('invalid path')
      if (q.untracked) return newFileDiff(root, path)
      return clipDiff((await git(root, ['diff', '--no-color', ...(q.staged ? ['--cached'] : []), '--', path])).out)
    }
    if (q.kind === 'commit') {
      if (!SHA.test(String(q.sha))) throw bad('invalid commit')
      return clipDiff((await git(root, ['show', '--no-color', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n%B', q.sha, '--'])).out)
    }
    if (q.kind === 'stash') {
      if (!STASH.test(String(q.ref))) throw bad('invalid stash')
      return clipDiff((await git(root, ['stash', 'show', '-p', '--include-untracked', '--no-color', q.ref], { okCodes: [0, 1] })).out)
    }
    throw bad('kind: file, commit or stash')
  }

  const paths = list => {
    if (!Array.isArray(list) || !list.length || list.length > 2000) throw bad('paths')
    return list.map(p => {
      const s = String(p)
      if (!s || s.startsWith('-')) throw bad('invalid path')
      return s
    })
  }
  const branch = v => { const s = String(v || ''); if (!BRANCH.test(s)) throw bad('invalid branch name'); return s }
  const sha = v => { const s = String(v || ''); if (!SHA.test(s)) throw bad('invalid commit'); return s }
  const stashRef = v => { const s = String(v || ''); if (!STASH.test(s)) throw bad('invalid stash'); return s }

  /** One change, by name. Returns git's own words. */
  async function act(id, a) {
    const root = await rootOf(id)
    const run = (args, opts) => git(root, args, opts)
    const net = { timeout: NETWORK_MS }
    let r
    switch (a.op) {
      case 'stage': r = await run(['add', '--', ...paths(a.paths)]); break
      case 'stageAll': r = await run(['add', '-A']); break
      case 'unstage': r = await run(['restore', '--staged', '--', ...paths(a.paths)]); break
      case 'unstageAll': r = await run(['reset', '-q']); break
      case 'discard': {
        const p = paths(a.paths)
        if (a.untracked) r = await run(['clean', '-f', '--', ...p])
        else r = await run(['restore', '--worktree', '--', ...p])
        break
      }
      case 'commit': {
        const msg = String(a.message || '').trim()
        if (!msg) throw bad('write a commit message')
        r = await run(['commit', ...(a.amend ? ['--amend'] : []), '-m', msg.slice(0, 20_000)])
        break
      }
      case 'checkout': r = await run(['switch', ...(a.remote ? ['--track'] : []), branch(a.branch)]); break
      case 'createBranch': r = await run(['switch', '-c', branch(a.name), ...(a.from ? [branch(a.from)] : [])]); break
      case 'deleteBranch': r = await run(['branch', a.force ? '-D' : '-d', branch(a.branch)]); break
      case 'merge': r = await run(['merge', '--no-edit', branch(a.branch)]); break
      case 'mergeAbort': r = await run(['merge', '--abort']); break
      case 'revert': r = await run(['revert', '--no-edit', sha(a.sha)]); break
      case 'cherryPick': r = await run(['cherry-pick', sha(a.sha)]); break
      case 'stash': r = await run(['stash', 'push', '--include-untracked', ...(a.message ? ['-m', String(a.message).slice(0, 200)] : [])]); break
      case 'stashApply': r = await run(['stash', 'apply', stashRef(a.ref)]); break
      case 'stashPop': r = await run(['stash', 'pop', stashRef(a.ref)]); break
      case 'stashDrop': r = await run(['stash', 'drop', stashRef(a.ref)]); break
      case 'fetch': r = await run(['fetch', '--all', '--prune'], net); break
      case 'pull': r = await run(['pull', '--ff-only'], net); break
      case 'push': {
        const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [0, 128] })
        r = await run(up.code === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD'], net)
        break
      }
      default: throw bad('unknown action')
    }
    return { ok: true, output: (r.out + r.err).trim().slice(-4000) }
  }

  return { repos, state, log, diff, act }
}
