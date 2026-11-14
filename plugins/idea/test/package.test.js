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
