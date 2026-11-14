import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStatus, parseLog, newFileDiff, git, createLocalGit } from '../lib/git-local.js'

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

test('newFileDiff shows a new file and refuses paths outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idea-git-'))
  await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(root, 'bin'), Buffer.from([1, 0, 2]))
  const outside = await mkdtemp(join(tmpdir(), 'idea-out-'))
  await writeFile(join(outside, 'secret'), 'x')
  await symlink(join(outside, 'secret'), join(root, 'link'))
  assert.equal((await newFileDiff(root, 'a.txt')).diff, 'new file: a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n')
  assert.match((await newFileDiff(root, 'bin')).diff, /Binary file/)
  await assert.rejects(newFileDiff(root, '../x'), /invalid path/)
  await assert.rejects(newFileDiff(root, 'link'), /invalid path/)
})

test('a repository is changed by workspace id, with checked names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idea-repo-'))
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
