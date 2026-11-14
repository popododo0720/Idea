import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { createTools, NOT_PAIRED } from '../lib/tools.js'
import { close, hasOpenssl, listen, selfSigned, tempDir } from './helpers.js'

const noOpenssl = !hasOpenssl() && 'openssl is not installed'
const TOKEN = 'device-token-secret'

/** A paired dsh and a fake machine; `answer(req)` returns [status, value]. */
async function setup(t, { paired = true, answer = () => [200, {}] } = {}) {
  const { cert, key } = selfSigned()
  const seen = []
  const server = createServer({ cert, key }, (req, res) => {
    let text = ''
    req.on('data', c => { text += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined })
      const [status, value] = answer(req)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    })
  })
  const port = await listen(server)
  t.after(() => close(server))
  const home = tempDir(t, 'idea-tools-')
  process.env.DSH_HOME = home
  process.env.HOME = home
  delete process.env.IDEA_DEV_DSH_LOGIN
  if (paired) {
    await mkdir(join(home, 'idea'), { recursive: true })
    await writeFile(join(home, 'idea', 'pairing.json'), JSON.stringify({ url: `https://127.0.0.1:${port}`, token: TOKEN, id: 'abc', host: 'm', cert }))
  }
  const tools = new Map()
  const disposers = []
  apply({
    effect: fn => { disposers.push(fn()) },
    on: () => {},
    get: () => undefined,
    logger: { info() {}, warn() {} },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
    tools: { register: tool => { tools.set(tool.name, tool) } },
  })
  t.after(() => { while (disposers.length) disposers.pop()?.() })
  const run = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal })
  return { run, seen, tools }
}

const STATUS = {
  projects: [{ name: 'alpha', repo: 'idea/alpha', ready: true }, { name: 'beta', repo: 'idea/beta', ready: false, message: 'setting up' }],
  tasks: [
    { project: 'alpha', issue: 3, title: 'Fix it', phase: 'Succeeded', pullRequest: 9, message: 'merged' },
    { project: 'beta', issue: 1, title: 'Start', phase: 'Working' },
  ],
}

test('the plugin registers the three tools, and their descriptions ask for a complete issue body', { skip: noOpenssl }, async t => {
  const { tools } = await setup(t)
  assert.deepEqual([...tools.keys()].sort(), ['idea_projects', 'idea_task_create', 'idea_tasks'])
  assert.match(tools.get('idea_task_create').description, /goal.*what to change.*acceptance criteria/s)
})

test('idea_task_create posts the task with the device token and returns issue and task', { skip: noOpenssl }, async t => {
  const m = await setup(t, { answer: () => [201, { project: 'alpha', issue: 7, task: 'alpha-7' }] })
  const r = await m.run('idea_task_create', { project: 'alpha', title: ' Do it ', body: 'Goal...' })
  assert.equal(r.ok, true)
  assert.match(r.text, /alpha/)
  assert.match(r.text, /#7/)
  assert.match(r.text, /alpha-7/)
  assert.deepEqual(m.seen, [{ method: 'POST', url: '/api/v1/tasks', auth: `Bearer ${TOKEN}`, body: { project: 'alpha', title: 'Do it', body: 'Goal...' } }])
  assert.ok(!JSON.stringify(r).includes(TOKEN))
})

test('idea_tasks lists tasks, optionally of one project; idea_projects lists projects', { skip: noOpenssl }, async t => {
  const m = await setup(t, { answer: () => [200, STATUS] })
  const all = await m.run('idea_tasks', {})
  assert.match(all.text, /alpha#3 Fix it \| Succeeded \| PR #9 \| merged/)
  assert.match(all.text, /beta#1 Start \| Working/)
  const one = await m.run('idea_tasks', { project: 'beta' })
  assert.doesNotMatch(one.text, /alpha/)
  assert.equal((await m.run('idea_tasks', { project: 'gamma' })).text, 'No tasks.')
  const ps = await m.run('idea_projects', {})
  assert.match(ps.text, /^alpha\nbeta \(not ready yet\) \| setting up$/)
  assert.ok(m.seen.every(s => s.method === 'GET' && s.url === '/api/v1/status' && s.auth === `Bearer ${TOKEN}`))
})

test('empty answers read as none', { skip: noOpenssl }, async t => {
  const m = await setup(t, { answer: () => [200, {}] })
  assert.equal((await m.run('idea_tasks', {})).text, 'No tasks.')
  assert.equal((await m.run('idea_projects', {})).text, 'No projects.')
})

test('without a pairing every tool answers a clear error and does not throw', async t => {
  const m = await setup(t, { paired: false })
  for (const [name, args] of [['idea_task_create', { project: 'alpha', title: 't', body: 'b' }], ['idea_tasks', {}], ['idea_projects', {}]]) {
    const r = await m.run(name, args)
    assert.equal(r.ok, false)
    assert.match(r.text, /not paired with an idea machine/)
  }
  assert.match(NOT_PAIRED, /not paired with an idea machine/)
  assert.equal(m.seen.length, 0)
})

test('a 4xx or 5xx of the machine is passed on as a tool error', { skip: noOpenssl }, async t => {
  for (const status of [400, 404, 502]) {
    const m = await setup(t, { answer: () => [status, { error: `machine says ${status}` }] })
    await assert.rejects(m.run('idea_task_create', { project: 'alpha', title: 't', body: 'b' }), new RegExp(`machine says ${status}`))
    await assert.rejects(m.run('idea_tasks', {}), new RegExp(`machine says ${status}`))
    await assert.rejects(m.run('idea_projects', {}), new RegExp(`machine says ${status}`))
  }
  const m = await setup(t, { answer: () => [500, 'oops'] })
  await assert.rejects(m.run('idea_projects', {}), /HTTP 500/)
})

test('an unreachable machine is a tool error', async t => {
  const m = await setup(t, { paired: false })
  const home = process.env.DSH_HOME
  const { cert } = selfSigned()
  await mkdir(join(home, 'idea'), { recursive: true })
  await writeFile(join(home, 'idea', 'pairing.json'), JSON.stringify({ url: 'https://127.0.0.1:1', token: TOKEN, id: 'a', host: 'm', cert }))
  await assert.rejects(m.run('idea_projects', {}), /could not reach the machine/)
})

test('idea_task_create validates its input before calling the machine', { skip: noOpenssl }, async t => {
  const m = await setup(t, { answer: () => [201, {}] })
  const ok = { project: 'alpha', title: 't', body: 'b' }
  await assert.rejects(m.run('idea_task_create', { ...ok, title: '' }), /title/)
  await assert.rejects(m.run('idea_task_create', { ...ok, title: '   ' }), /title/)
  await assert.rejects(m.run('idea_task_create', { ...ok, title: 'x'.repeat(201) }), /title/)
  await assert.rejects(m.run('idea_task_create', { ...ok, body: 'x'.repeat(20001) }), /body/)
  await assert.rejects(m.run('idea_task_create', { ...ok, project: 'Bad Name' }), /project/)
  await assert.rejects(m.run('idea_tasks', { project: 'Bad Name' }), /project/)
  assert.equal(m.seen.length, 0)
  await m.run('idea_task_create', { ...ok, title: 'x'.repeat(200), body: 'x'.repeat(20000) })
  assert.equal(m.seen.length, 1)
})

test('createTools reports a missing project from the machine answer', async () => {
  const [create] = createTools({ ask: async () => ({ status: 201, value: null }) })
  const r = await create.execute({ project: 'alpha', title: 't', body: '' }, undefined)
  assert.match(r.text, /alpha/)
})
