import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessages, teamsOf, teamView } from '../lib/team-view.js'

const out = (t, from, to, text, extra = {}) => ({ t, team: 'aaaa0001', from, fromVm: 'idea-dsh', to, toVm: 'idea-worker-0', text, dir: 'out', ...extra })

test('one copy per message, the receiver copy only when the sender is missing', () => {
  const a = out('2026-01-01T00:00:01Z', 'lead', 'alice', 'hi')
  const aIn = { ...a, t: '2026-01-01T00:00:02Z', dir: 'in' }
  const b = { ...out('2026-01-01T00:00:03Z', 'bob', 'lead', 'done'), fromVm: 'idea-worker-1', toVm: 'idea-dsh' }
  const bIn = { ...b, dir: 'in' }
  const merged = mergeMessages([{ messages: [a] }, { messages: [aIn] }, { messages: [bIn] }])
  assert.deepEqual(merged.map(m => [m.from, m.dir]), [['lead', 'out'], ['bob', 'in']])
  assert.equal(mergeMessages([{ messages: [a, a] }, { messages: [aIn] }]).length, 2, 'the same text twice stays twice')
  assert.equal(mergeMessages([null, { messages: [{ bad: true }] }]).length, 0)
})

test('teams newest first, rosters from the lead VM, last word per member', () => {
  const logs = [
    { vm: 'idea-worker-0', rosters: { aaaa0001: [{ name: 'old', vm: 'idea-worker-0', session: 's0' }], bbbb0002: [{ name: 'x', vm: 'idea-worker-0' }] } },
    { vm: 'idea-dsh', rosters: { aaaa0001: [{ name: 'lead', vm: 'idea-dsh', session: 's1', role: 'team lead' }, { name: 'alice', vm: 'idea-worker-0', session: 's2', role: 'api' }] } },
  ]
  const messages = [
    { ...out('2026-01-01T00:00:01Z', 'x', 'lead', 'old team'), team: 'bbbb0002' },
    out('2026-01-01T00:00:05Z', 'alice', 'lead', 'ready'),
  ]
  const { teams } = teamsOf(logs, messages)
  assert.deepEqual(teams.map(t => t.team), ['aaaa0001', 'bbbb0002'])
  assert.deepEqual(teams[0].members.map(m => m.name), ['lead', 'alice'])
  assert.equal(teams[0].members[1].lastText, 'ready')
  assert.equal(teams[0].members[0].lastText, '')
})

test('agents that left the roster show as stopped', () => {
  const logs = [{ vm: 'idea-dsh', rosters: { aaaa0001: [{ name: 'lead', vm: 'idea-dsh', session: 's1' }] } }]
  const messages = [out('2026-01-01T00:00:01Z', 'lead', 'alice', 'go'), out('2026-01-01T00:00:02Z', 'lead', 'all', 'hi all')]
  const { teams } = teamsOf(logs, messages)
  assert.deepEqual(teams[0].members.map(m => [m.name, m.vm, m.status ?? '']), [['lead', 'idea-dsh', ''], ['alice', 'idea-worker-0', 'stopped']])
})

test('teamView reads every VM and asks each member whether it works', async () => {
  const views = {
    '': {
      json: async () => ({ status: 200, text: JSON.stringify({ messages: [out('2026-01-01T00:00:01Z', 'lead', 'alice', 'go')], rosters: { aaaa0001: [{ name: 'lead', vm: 'idea-dsh', session: 's1' }, { name: 'alice', vm: 'idea-worker-0', session: 's2' }] } }) }),
      rpc: async () => ({ running: false }),
    },
    'idea-worker-0': {
      json: async () => { throw new Error('down') },
      rpc: async () => ({ running: true }),
    },
  }
  const v = await teamView({ workers: ['idea-worker-0'], viewOf: vm => views[vm] })
  assert.deepEqual(v.errors.map(e => e.vm), ['idea-worker-0'])
  assert.deepEqual(v.teams[0].members.map(m => m.status), ['idle', 'unknown'])
  assert.equal(v.messages.length, 1)
})
