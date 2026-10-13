// Which parts of the repository a change can affect (D16).
// Every check script reads this mapping through scripts/parts.sh.
// An issue that adds a part, or a dependency between parts, updates PARTS here.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// `paths` are the prefixes that make a part "checked". `needs` lists the parts it builds on.
export const PARTS = [
  {
    name: 'core',
    label: 'the core',
    // A core test checks the pinned model files against the models reference.
    paths: ['core/', 'tests/fixtures/', 'docs/reference/models.md'],
    needs: [],
  },
  { name: 'web', label: 'the web client', paths: ['web/', 'core/', 'tests/fixtures/'], needs: ['core'] },
  {
    name: 'e2e',
    label: 'the Playwright journeys',
    paths: ['tests/e2e/', 'tests/fixtures/', 'web/', 'core/'],
    needs: ['web'],
  },
  { name: 'android', label: 'the Android app', paths: ['android/', 'core/'], needs: ['core'] },
  { name: 'models', label: 'the model tool', paths: ['tools/model-tool/'], needs: [] },
]

// A change under one of these paths can affect every part.
export const EVERY_PART_PATHS = ['scripts/']

const startsWithAny = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix))

// The parts with a changed path in their own row, in PARTS order.
export function checkedParts(paths) {
  if (paths.some((file) => startsWithAny(file, EVERY_PART_PATHS))) {
    return PARTS.map((part) => part.name)
  }
  return PARTS.filter((part) => paths.some((file) => startsWithAny(file, part.paths))).map(
    (part) => part.name,
  )
}

// The parts that the checked parts build on, without the checked parts, in PARTS order.
export function neededParts(checked) {
  const wanted = new Set(checked)
  const queue = [...checked]
  while (queue.length > 0) {
    const name = queue.pop()
    const part = PARTS.find((candidate) => candidate.name === name)
    for (const need of part.needs) {
      if (!wanted.has(need)) {
        wanted.add(need)
        queue.push(need)
      }
    }
  }
  return PARTS.map((part) => part.name).filter((name) => wanted.has(name) && !checked.includes(name))
}

// The paths changed since `base`, untracked files included. Null when the base is unknown.
export function changedPaths(base, cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
    // --no-renames lists both the old and the new path of a move.
    const changed = git('diff', '--name-only', '--no-renames', base)
    const untracked = git('ls-files', '--others', '--exclude-standard')
    const lines = `${changed}\n${untracked}`.split('\n').filter((line) => line !== '')
    return [...new Set(lines)]
  } catch {
    return null
  }
}

function report(base, checked, needed) {
  const lines = [`base ${base}`]
  for (const part of PARTS) {
    const state = checked.includes(part.name)
      ? 'checked'
      : needed.includes(part.name)
        ? 'needed'
        : 'skipped'
    lines.push(`${part.name} ${state} ${part.label}`)
  }
  return lines.join('\n')
}

function main() {
  const base = process.env.NEXKIT_BASE_SHA ?? ''
  const everyPart = PARTS.map((part) => part.name)
  if (base === '') {
    console.log(report('-', everyPart, []))
    return
  }
  const paths = changedPaths(base, fileURLToPath(new URL('..', import.meta.url)))
  if (paths === null) {
    console.error(`NEXKIT_BASE_SHA ${base} is not a commit here: checking every part.`)
    console.log(report('-', everyPart, []))
    return
  }
  const checked = checkedParts(paths)
  console.log(report(base, checked, neededParts(checked)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
