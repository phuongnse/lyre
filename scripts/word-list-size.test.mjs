import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LIMIT, checkAddedSize } from './word-list-size.mjs'

const script = fileURLToPath(new URL('./word-list-size.mjs', import.meta.url))

let root

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'word-list-size-'))
})

after(() => rmSync(root, { recursive: true, force: true }))

// Writes a "without" file of 10 bytes and a "with" file `added` bytes larger.
function modules(name, added) {
  const withPath = path.join(root, `${name}.with.wasm`)
  const withoutPath = path.join(root, `${name}.without.wasm`)
  writeFileSync(withoutPath, Buffer.alloc(10))
  writeFileSync(withPath, Buffer.alloc(10 + added))
  return [withPath, withoutPath]
}

describe('checkAddedSize', () => {
  test('the limit is 500,000 bytes', () => {
    assert.equal(LIMIT, 500_000)
  })

  test('passes when the list adds exactly the limit', () => {
    assert.equal(checkAddedSize(...modules('at-limit', LIMIT)), LIMIT)
  })

  test('fails when the list adds one byte over the limit', () => {
    assert.throws(() => checkAddedSize(...modules('over-limit', LIMIT + 1)), /500001 bytes/)
  })
})

describe('word-list-size.mjs', () => {
  test('prints the added bytes and exits 0 within the limit', () => {
    const result = spawnSync('node', [script, ...modules('main-ok', 1234)], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /adds 1234 bytes/)
  })

  test('exits 1 over the limit', () => {
    const result = spawnSync('node', [script, ...modules('main-over', LIMIT + 1)], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /over the limit/)
  })
})
