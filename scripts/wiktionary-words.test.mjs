import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { generate, matchingKey, sha256OfFile } from './wiktionary-words.mjs'

const script = fileURLToPath(new URL('./wiktionary-words.mjs', import.meta.url))

let root

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wiktionary-words-'))
})

after(() => rmSync(root, { recursive: true, force: true }))

const entry = (word, pos = 'noun', langCode = 'vi') =>
  JSON.stringify({ word, pos, lang: 'Vietnamese', lang_code: langCode })

describe('wiktionary-words.mjs', () => {
  test('rejects a dump whose SHA-256 does not match the pinned hash', () => {
    const dump = path.join(root, 'wrong.jsonl')
    const out = path.join(root, 'wrong.txt')
    writeFileSync(dump, `${entry('kỷ niệm')}\n`)
    const result = spawnSync('node', [script, dump, out], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /SHA-256/)
    assert.match(result.stderr, new RegExp(sha256OfFile(dump)))
    assert.equal(existsSync(out), false)
  })

  test('keeps only Vietnamese entries of two or more Latin-script syllables', () => {
    const dump = path.join(root, 'sample.jsonl')
    const out = path.join(root, 'sample.txt')
    writeFileSync(
      dump,
      [
        entry('kỷ niệm'),
        entry('love story', 'noun', 'en'),
        entry('ăn quả nhớ kẻ trồng cây', 'proverb'),
        entry('ăn cháo đá bát', 'phrase'),
        entry('紀念', 'character'),
        entry('kỷ 念'),
        entry('Wi-Fi'),
        entry('F1 đua xe'),
        entry('em'),
        entry('Hà Nội', 'name'),
        entry('hòa bình'),
        entry('hoà bình'),
        entry('Kỷ niệm', 'verb'),
        '',
      ].join('\n'),
    )
    assert.equal(generate(dump, out, sha256OfFile(dump)), 4)
    const lines = readFileSync(out, 'utf8').split('\n')
    const words = lines.filter((line) => line !== '' && !line.startsWith('#'))
    // Plain code unit order: "o" comes before "à".
    assert.deepEqual(words, ['hoà bình', 'hà nội', 'kỷ niệm', 'ăn cháo đá bát'])
    assert.ok(lines.some((line) => line.startsWith('#') && line.includes('CC BY-SA 4.0')))
    assert.equal(lines.at(-1), '')
  })

  test('matches tone placement and case like the core', () => {
    assert.equal(matchingKey('hoà bình'), matchingKey('hòa bình'))
    assert.equal(matchingKey('Thuỷ'), matchingKey('thủy'))
    assert.notEqual(matchingKey('hoà'), matchingKey('hoá'))
  })
})
