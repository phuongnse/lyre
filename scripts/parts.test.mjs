import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkedParts, neededParts } from './parts.mjs'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))

describe('parts picked from changed paths', () => {
  test('docs only pick no part', () => {
    assert.deepEqual(checkedParts(['docs/decisions.md', 'README.md', '.github/x.yml']), [])
    assert.deepEqual(checkedParts([]), [])
  })

  test('web picks the web client and the journeys', () => {
    assert.deepEqual(checkedParts(['web/src/main.ts']), ['web', 'e2e'])
  })

  test('android picks the Android app', () => {
    assert.deepEqual(checkedParts(['android/app/build.gradle.kts']), ['android'])
  })

  test('tests/e2e picks the journeys', () => {
    assert.deepEqual(checkedParts(['tests/e2e/a.spec.ts']), ['e2e'])
  })

  test('core and scripts pick every part', () => {
    const every = ['core', 'web', 'e2e', 'android']
    assert.deepEqual(checkedParts(['core/Cargo.toml']), every)
    assert.deepEqual(checkedParts(['scripts/lint.sh']), every)
  })

  test('tests/fixtures picks the core and the Playwright journeys', () => {
    assert.deepEqual(checkedParts(['tests/fixtures/song/lyrics.txt']), ['core', 'e2e'])
  })

  test('lyre-cli picks every part, as the rest of the core does', () => {
    const every = ['core', 'web', 'e2e', 'android']
    assert.deepEqual(checkedParts(['core/lyre-cli/src/main.rs']), every)
  })

  test('a mixed list picks the union in order', () => {
    assert.deepEqual(checkedParts(['docs/a.md', 'android/x.kt', 'tests/e2e/b.ts']), [
      'e2e',
      'android',
    ])
  })

  test('a checked part brings what it builds on', () => {
    assert.deepEqual(neededParts(checkedParts(['web/x.ts'])), ['core'])
    assert.deepEqual(neededParts(checkedParts(['tests/e2e/x.ts'])), ['core', 'web'])
    assert.deepEqual(neededParts(checkedParts(['android/x.kt'])), ['core'])
    assert.deepEqual(neededParts([]), [])
    assert.deepEqual(neededParts(checkedParts(['core/x.rs'])), [])
  })
})

describe('scripts in a repository', () => {
  const scripts = ['setup.sh', 'build.sh', 'lint.sh', 'test.sh', 'e2e.sh']
  const stubs = [
    'cargo',
    'npm',
    'npx',
    'rustup',
    'wasm-bindgen',
    'ktlint',
    'java',
    'sudo',
    'curl',
    'unzip',
  ]
  let root
  let bin
  let home
  let log
  let base

  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  // Runs a command in the fixture with the stub tools first on the PATH.
  const run = (command, args, extraEnv = {}) => {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      STUB_LOG: log,
    }
    delete env.CI
    // Without this the nested node --test would stay silent.
    delete env.NODE_TEST_CONTEXT
    delete env.NEXKIT_BASE_SHA
    return spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' })
  }
  const stubCalls = () => readFileSync(log, 'utf8')

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'parts-'))
    bin = path.join(root, '..', `${path.basename(root)}-bin`)
    home = path.join(root, '..', `${path.basename(root)}-home`)
    log = path.join(bin, 'stub.log')
    mkdirSync(bin)
    mkdirSync(home)
    writeFileSync(log, '')
    for (const stub of stubs) {
      const file = path.join(bin, stub)
      writeFileSync(file, '#!/usr/bin/env bash\necho "$(basename "$0") $*" >> "$STUB_LOG"\n')
      chmodSync(file, 0o755)
    }

    mkdirSync(path.join(root, 'scripts'))
    // The test files are left out: copying them would make the tests run themselves.
    for (const name of readdirSync(scriptsDir)) {
      if (name.endsWith('.sh') || name === 'parts.mjs' || name === 'check-links.mjs') {
        copyFileSync(path.join(scriptsDir, name), path.join(root, 'scripts', name))
      }
    }
    writeFileSync(
      path.join(root, 'scripts', 'fixture.test.mjs'),
      "import { test } from 'node:test'\ntest('fixture test ran', () => {})\n",
    )
    const markers = {
      'core/Cargo.toml': '',
      'web/package.json': '{}',
      'web/src/lyre-wasm/lyre_wasm.js': '',
      'tests/e2e/package.json': '{}',
      'android/settings.gradle.kts': '',
      'docs/a.md': '# A\n',
    }
    for (const [file, content] of Object.entries(markers)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), content)
    }
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'base')
    base = git('rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'docs', 'b.md'), '# B\n')
    git('add', '-A')
    git('commit', '-qm', 'docs')
  })

  after(() => {
    for (const dir of [root, bin, home]) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a docs-only change runs no part in any script', () => {
    for (const script of scripts) {
      writeFileSync(log, '')
      const result = run('bash', [`scripts/${script}`], { NEXKIT_BASE_SHA: base })
      assert.equal(result.status, 0, `${script}: ${result.stderr}`)
      assert.equal(stubCalls(), '', `${script} called a tool`)
      if (script === 'e2e.sh') {
        assert.match(result.stdout, new RegExp(`Skipping the Playwright journeys: .*${base}`))
      } else {
        assert.match(result.stdout, new RegExp(`Skipping the Android app: .*${base}`))
      }
      if (script === 'lint.sh') {
        assert.match(result.stdout, /Checked \d+ links/)
      }
      if (script === 'test.sh') {
        assert.match(result.stdout, /fixture test ran/)
      }
    }
  })

  test('an untracked file under web/ picks the web client, the journeys and the core', () => {
    const file = path.join(root, 'web', 'x.ts')
    writeFileSync(file, '')
    try {
      const result = run('node', ['scripts/parts.mjs'], { NEXKIT_BASE_SHA: base })
      assert.equal(result.status, 0, result.stderr)
      const states = result.stdout.split('\n').map((line) => line.split(' ').slice(0, 2).join(' '))
      assert.deepEqual(states.slice(1, 5), [
        'core needed',
        'web checked',
        'e2e checked',
        'android skipped',
      ])
    } finally {
      rmSync(file)
    }
  })

  test('an unset or unknown base checks every part', () => {
    const unknown = '0000000000000000000000000000000000000000'
    for (const env of [{}, { NEXKIT_BASE_SHA: unknown }]) {
      const parts = run('node', ['scripts/parts.mjs'], env)
      assert.equal(parts.status, 0, parts.stderr)
      const states = parts.stdout.split('\n').slice(1, 5).map((line) => line.split(' ')[1])
      assert.deepEqual(states, ['checked', 'checked', 'checked', 'checked'])
      if (env.NEXKIT_BASE_SHA) {
        assert.match(parts.stderr, /is not a commit here: checking every part/)
      }

      writeFileSync(log, '')
      const lint = run('bash', ['scripts/lint.sh'], env)
      assert.equal(lint.status, 0, lint.stderr)
      const calls = stubCalls()
      assert.match(calls, /cargo fmt/)
      assert.match(calls, /npm run lint/)
      assert.match(calls, /ktlint/)
    }
  })
})
