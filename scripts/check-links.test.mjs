import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectHeadings, slugify } from './check-links.mjs'

const script = fileURLToPath(new URL('./check-links.mjs', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

let root

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'check-links-'))
  writeFileSync(
    path.join(root, 'a.md'),
    [
      '# A',
      '',
      'See [the decision](b.md#d15-presentation-model--agreed) and [this file](#a).',
      'A [missing file](missing.md).',
      'A [missing anchor](b.md#no-such-heading).',
      'An [external link](https://example.com/x.md) and `[code](inline.md)`.',
      '',
      '```md',
      '[fenced](nowhere.md)',
      '```',
      '',
      '[reference]: missing-reference.md',
    ].join('\n'),
  )
  writeFileSync(path.join(root, 'b.md'), '# B\n\n## D15. Presentation model — Agreed\n')
  mkdirSync(path.join(root, 'node_modules/x'), { recursive: true })
  writeFileSync(path.join(root, 'node_modules/x/README.md'), '[broken](gone.md)\n')
})

after(() => rmSync(root, { recursive: true, force: true }))

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('slugify', () => {
  test('follows GitHub heading anchors', () => {
    assert.equal(slugify('D15. Presentation model — Agreed'), 'd15-presentation-model--agreed')
    assert.equal(slugify('The `kind` property'), 'the-kind-property')
    assert.equal(slugify('See [Storage](#storage) *now*'), 'see-storage-now')
    assert.equal(slugify('snake_case names'), 'snake_case-names')
    assert.equal(slugify('Übersicht: Entwürfe'), 'übersicht-entwürfe')
  })
})

describe('collectHeadings', () => {
  test('numbers repeated headings and skips code fences', () => {
    const markdown = ['# Notes', '## Notes', '```', '# Not a heading', '```', '## Notes ##'].join('\n')
    assert.deepEqual(collectHeadings(markdown), ['notes', 'notes-1', 'notes-2'])
  })
})

describe('CLI', () => {
  test('reports a missing file and a missing anchor with file and line', () => {
    const result = runCli(['--root', root])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /^a\.md:4: broken link 'missing\.md': file not found$/m)
    assert.match(
      result.stderr,
      /^a\.md:5: broken link 'b\.md#no-such-heading': anchor '#no-such-heading' not found in b\.md$/m,
    )
    assert.match(result.stderr, /^a\.md:12: broken link 'missing-reference\.md': file not found$/m)
    assert.equal(result.stderr.trim().split('\n').length, 3)
  })

  test('ignores code, external links and installed packages', () => {
    const { stderr } = runCli(['--root', root])

    assert.doesNotMatch(stderr, /nowhere\.md|inline\.md|example\.com|node_modules|gone\.md/)
  })

  test('passes on the repository', () => {
    const result = runCli(['--root', repositoryRoot])

    assert.equal(result.stderr, '')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^Checked \d+ links in \d+ Markdown files\.$/m)
  })
})
