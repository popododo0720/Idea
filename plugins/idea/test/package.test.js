import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const shipped = f => f === 'package.json' || pkg.files.some(e => e === f || (e.endsWith('/') && f.startsWith(e)))

test('every module the plugin imports is in the published files', () => {
  for (const f of readdirSync(join(root, 'lib'))) {
    if (!f.endsWith('.js')) continue
    assert.ok(shipped(`lib/${f}`), `lib/${f} is missing from package.json "files"`)
    const src = readFileSync(join(root, 'lib', f), 'utf8')
    for (const [, rel] of src.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
      assert.ok(shipped(`lib/${rel}`), `lib/${f} imports ./${rel}, which is not published`)
    }
  }
  for (const e of Object.values(pkg.exports)) assert.ok(shipped(e.replace(/^\.\//, '')), `${e} is exported but not published`)
})

test('every package the plugin imports is declared as a dependency or peer dependency', () => {
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})])
  const name = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2) : spec.split('/').slice(0, 1)).join('/')
  const imports = new Set()
  for (const f of readdirSync(join(root, 'lib'))) {
    if (!f.endsWith('.js') || f === 'client.js') continue
    const src = readFileSync(join(root, 'lib', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/gm)) {
      if (spec.startsWith('node:') || spec.startsWith('.')) continue
      imports.add(name(spec))
    }
  }
  assert.ok(imports.has('@deepseek-ai/dsh-tools'), 'the scan finds the dsh-tools import')
  for (const m of imports) assert.ok(declared.has(m), `lib imports ${m}, which package.json does not declare`)
})
