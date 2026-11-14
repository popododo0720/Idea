import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, symlink, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStatus, parseLog, newFileDiff, git, createLocalGit } from '../lib/git-local.js'
import { tempDir } from './helpers.js'

test('parseStatus reads the branch, changes, renames, conflicts and new files', () => {
  const text = [
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb src/a file.js',
    '1 .M N... 100644 100644 100644 aaa bbb b.js',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.js', 'old.js',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc c.js',
    '? notes.txt',
    '',
  ].join('\0')
  const { head, files } = parseStatus(text)
  assert.deepEqual(head, { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, oid: 'abc123' })
  assert.deepEqual(files.map(f => [f.path, f.x, f.y, f.staged, f.unstaged, f.untracked, f.conflict]), [
    ['src/a file.js', 'M', '.', true, false, false, false],
    ['b.js', '.', 'M', false, true, false, false],
    ['new.js', 'R', '.', true, false, false, false],
    ['c.js', 'U', 'U', false, true, false, true],
    ['notes.txt', '?', '?', false, true, true, false],
  ])
  assert.equal(files[2].from, 'old.js')
})

test('parseLog splits records and fields', () => {
  const rec = (...f) => '\x1e' + f.join('\x1f') + '\n'
  const out = parseLog(rec('a'.repeat(40), 'aaaaaaa', 'Ann', '2026-01-02T03:04:05+00:00', 'Fix: a | b', 'HEAD -> main, origin/main') + rec('b'.repeat(40), 'bbbbbbb', 'Bo', '2026-01-01T00:00:00+00:00', 'Start', ''))
  assert.equal(out.length, 2)
  assert.equal(out[0].subject, 'Fix: a | b')
  assert.equal(out[0].refs, 'HEAD -> main, origin/main')
  assert.equal(out[1].refs, '')
})

test('newFileDiff shows a new file and refuses paths outside the repository', async t => {
  const root = tempDir(t, 'idea-git-')
  await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(root, 'bin'), Buffer.from([1, 0, 2]))
  const outside = tempDir(t, 'idea-out-')
  await writeFile(join(outside, 'secret'), 'x')
  await symlink(join(outside, 'secret'), join(root, 'link'))
  assert.equal((await newFileDiff(root, 'a.txt')).diff, 'new file: a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n')
  assert.match((await newFileDiff(root, 'bin')).diff, /Binary file/)
  await assert.rejects(newFileDiff(root, '../x'), /invalid path/)
  await assert.rejects(newFileDiff(root, 'link'), /invalid path/)
})

test('a repository is changed by workspace id, with checked names', async t => {
  const root = tempDir(t, 'idea-repo-')
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.email', 't@example.com'])
  await git(root, ['config', 'user.name', 'T'])
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'f.txt'), 'hi\n')
  const lg = createLocalGit({ workspaces: () => [{ id: 'w1', title: 'Repo', path: join(root, 'sub') }, { id: 'w2', title: 'Plain', path: tmpdir() + '/does-not-exist' }] })
  const repos = await lg.repos()
  assert.deepEqual(repos.map(r => r.id), ['w1'])
  let s = await lg.state('w1')
  assert.deepEqual(s.files.map(f => f.path), ['sub/f.txt'])
  await lg.act('w1', { op: 'stageAll' })
  await lg.act('w1', { op: 'commit', message: 'first' })
  await lg.act('w1', { op: 'createBranch', name: 'feature/x' })
  s = await lg.state('w1')
  assert.equal(s.head.branch, 'feature/x')
  assert.deepEqual(s.branches.map(b => b.name).sort(), ['feature/x', 'main'])
  const { commits } = await lg.log('w1', 'main')
  assert.equal(commits[0].subject, 'first')
  assert.match((await lg.diff('w1', { kind: 'commit', sha: commits[0].sha })).diff, /\+hi/)
  await assert.rejects(lg.act('w1', { op: 'checkout', branch: '--orphan' }), /invalid branch/)
  await assert.rejects(lg.act('w1', { op: 'deleteBranch', branch: 'a..b' }), /invalid branch/)
  await assert.rejects(lg.act('w1', { op: 'stage', paths: ['-A'] }), /invalid path/)
  await assert.rejects(lg.state('nope'), /no such workspace/)
})

async function repoWith(t, files) {
  const root = tempDir(t, 'idea-act-')
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.email', 't@example.com'])
  await git(root, ['config', 'user.name', 'T'])
  for (const [f, text] of Object.entries(files)) await writeFile(join(root, f), text)
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'base'])
  return { root, lg: createLocalGit({ workspaces: () => [{ id: 'w', title: 'R', path: root }] }) }
}

test('discard, stash, merge and checkout change the real repository', async t => {
  const { root, lg } = await repoWith(t, { 'a.txt': 'one\n' })
  const read = f => readFile(join(root, f), 'utf8')

  await writeFile(join(root, 'a.txt'), 'changed\n')
  await writeFile(join(root, 'new.txt'), 'new\n')
  let s = await lg.state('w')
  assert.deepEqual(s.files.map(f => [f.path, f.untracked]), [['a.txt', false], ['new.txt', true]])
  assert.match((await lg.diff('w', { kind: 'file', path: 'a.txt' })).diff, /-one\n\+changed/)
  await lg.act('w', { op: 'discard', paths: ['a.txt'] })
  assert.equal(await read('a.txt'), 'one\n')
  await lg.act('w', { op: 'discard', paths: ['new.txt'], untracked: true })
  assert.deepEqual((await lg.state('w')).files, [])

  await writeFile(join(root, 'a.txt'), 'stashed\n')
  await lg.act('w', { op: 'stash', message: 'wip' })
  assert.equal(await read('a.txt'), 'one\n')
  s = await lg.state('w')
  assert.deepEqual(s.stashes.map(x => x.ref), ['stash@{0}'])
  assert.match(s.stashes[0].subject, /wip/)
  assert.match((await lg.diff('w', { kind: 'stash', ref: 'stash@{0}' })).diff, /\+stashed/)
  await lg.act('w', { op: 'stashApply', ref: 'stash@{0}' })
  assert.equal(await read('a.txt'), 'stashed\n')
  await lg.act('w', { op: 'discard', paths: ['a.txt'] })
  await lg.act('w', { op: 'stashPop', ref: 'stash@{0}' })
  assert.equal(await read('a.txt'), 'stashed\n')
  assert.deepEqual((await lg.state('w')).stashes, [])
  await lg.act('w', { op: 'stash' })
  await lg.act('w', { op: 'stashDrop', ref: 'stash@{0}' })
  assert.deepEqual((await lg.state('w')).stashes, [])
  await assert.rejects(lg.act('w', { op: 'stashPop', ref: 'stash@{0}; rm -rf /' }), /invalid stash/)
  await assert.rejects(lg.diff('w', { kind: 'stash', ref: 'HEAD' }), /invalid stash/)

  await lg.act('w', { op: 'createBranch', name: 'feature' })
  await writeFile(join(root, 'b.txt'), 'b\n')
  await lg.act('w', { op: 'stage', paths: ['b.txt'] })
  assert.equal((await lg.state('w')).files[0].staged, true)
  await lg.act('w', { op: 'unstage', paths: ['b.txt'] })
  assert.equal((await lg.state('w')).files[0].staged, false)
  await lg.act('w', { op: 'stageAll' })
  await lg.act('w', { op: 'commit', message: 'add b' })
  await lg.act('w', { op: 'checkout', branch: 'main' })
  assert.equal((await lg.state('w')).head.branch, 'main')
  await assert.rejects(readFile(join(root, 'b.txt')), { code: 'ENOENT' })
  const merged = await lg.act('w', { op: 'merge', branch: 'feature' })
  assert.equal(merged.ok, true)
  assert.equal(await read('b.txt'), 'b\n')
  await lg.act('w', { op: 'deleteBranch', branch: 'feature' })
  assert.deepEqual((await lg.state('w')).branches.map(b => b.name), ['main'])

  const [head] = (await lg.log('w', '')).commits
  assert.equal(head.subject, 'add b')
  await lg.act('w', { op: 'revert', sha: head.sha })
  await assert.rejects(readFile(join(root, 'b.txt')), { code: 'ENOENT' })
  await lg.act('w', { op: 'cherryPick', sha: head.short })
  assert.equal(await read('b.txt'), 'b\n')
  await assert.rejects(lg.act('w', { op: 'revert', sha: 'HEAD~1' }), /invalid commit/)
  await assert.rejects(lg.act('w', { op: 'cherryPick', sha: '--abort' }), /invalid commit/)
})

test('changes refuse option-like paths, empty input and unknown kinds', async t => {
  const { lg } = await repoWith(t, { 'a.txt': 'one\n' })
  await assert.rejects(lg.diff('w', { kind: 'file', path: '--output=/tmp/x' }), /invalid path/)
  await assert.rejects(lg.diff('w', { kind: 'file', path: '' }), /invalid path/)
  await assert.rejects(lg.diff('w', { kind: 'commit', sha: 'HEAD' }), /invalid commit/)
  await assert.rejects(lg.diff('w', { kind: 'tree' }), /kind: file, commit or stash/)
  await assert.rejects(lg.act('w', { op: 'discard', paths: [] }), /paths/)
  await assert.rejects(lg.act('w', { op: 'discard', paths: 'a.txt' }), /paths/)
  await assert.rejects(lg.act('w', { op: 'unstage', paths: ['--', 'a.txt'] }), /invalid path/)
  await assert.rejects(lg.act('w', { op: 'commit', message: '   ' }), /write a commit message/)
  await assert.rejects(lg.act('w', { op: 'merge', branch: '-X' }), /invalid branch/)
  await assert.rejects(lg.log('w', '--output=/tmp/x'), /invalid branch/)
  const e = await lg.act('w', { op: 'checkout', branch: 'missing' }).catch(x => x)
  assert.equal(e.status, 409, 'a git failure is a conflict with git\'s own words')
})

test('push, fetch and pull work against a local remote', async t => {
  const remote = tempDir(t, 'idea-remote-')
  await git(remote, ['init', '-q', '--bare', '-b', 'main'])
  const { root, lg } = await repoWith(t, { 'a.txt': 'one\n' })
  await git(root, ['remote', 'add', 'origin', remote])
  await lg.act('w', { op: 'push' })
  assert.equal((await lg.state('w')).head.upstream, 'origin/main', 'the first push sets the upstream')
  const other = tempDir(t, 'idea-clone-')
  await git(other, ['clone', '-q', remote, '.'])
  await writeFile(join(root, 'a.txt'), 'two\n')
  await lg.act('w', { op: 'stageAll' })
  await lg.act('w', { op: 'commit', message: 'two' })
  await lg.act('w', { op: 'push' })
  const lg2 = createLocalGit({ workspaces: () => [{ id: 'c', title: 'C', path: other }] })
  await lg2.act('c', { op: 'fetch' })
  await lg2.act('c', { op: 'pull' })
  assert.equal(await readFile(join(other, 'a.txt'), 'utf8'), 'two\n')
  assert.ok((await lg2.state('c')).branches.some(b => b.remote && b.name === 'origin/main'))
})
