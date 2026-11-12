import test from 'node:test'
import assert from 'node:assert/strict'
import { add, subtract } from '../src/calc.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
  assert.equal(add(-1, 1), 0)
})

test('subtract', () => {
  assert.equal(subtract(5, 3), 2)
})
