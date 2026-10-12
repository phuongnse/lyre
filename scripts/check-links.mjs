// Checks the relative links and anchors in every Markdown file of the repository.
//
// Usage: node scripts/check-links.mjs [--root DIR]
//
// Every relative link must name an existing file or folder, and every #anchor must
// match an ATX heading of the target file under GitHub's heading slug rules. External
// links and links inside code fences or inline code are not checked. Build output and
// installed packages are skipped. Prints one line per broken link on stderr as
// file:line and exits 1 when any link is broken.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const skippedDirectories = new Set([
  '.git',
  '.gradle',
  'node_modules',
  'target',
  'build',
  'dist',
  'artifacts',
  'playwright-report',
  'test-results',
])

const fencePattern = /^\s*(`{3,}|~{3,})/
const headingPattern = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
const inlineCodePattern = /(`+)[\s\S]*?\1/g
const inlineLinkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const referencePattern = /^\s*\[[^\]]+\]:\s*(\S+)/
const schemePattern = /^[a-z][a-z0-9+.-]*:/i

/** Turns a heading into its GitHub anchor, without the suffix for repeated headings. */
export function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll('`', '')
    .replace(/(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1/g, '$2')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-')
}

/** Calls visit(line, lineNumber) for every line of the Markdown text outside code fences. */
function forEachProseLine(markdown, visit) {
  let fence
  markdown.split(/\r?\n/).forEach((line, index) => {
    const marker = fencePattern.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      return
    }
    if (marker) {
      fence = marker
      return
    }
    visit(line, index + 1)
  })
}

/** Returns the anchors of the ATX headings in the Markdown text, in order. */
export function collectHeadings(markdown) {
  const anchors = []
  const counts = new Map()
  forEachProseLine(markdown, (line) => {
    const match = headingPattern.exec(line)
    if (!match) return
    const slug = slugify(match[1])
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    anchors.push(count === 0 ? slug : `${slug}-${count}`)
  })
  return anchors
}

/** Returns the link targets of the Markdown text with their line numbers. */
function collectLinks(markdown) {
  const links = []
  forEachProseLine(markdown, (line, lineNumber) => {
    const prose = line.replace(inlineCodePattern, '')
    for (const match of prose.matchAll(inlineLinkPattern)) links.push({ target: match[1], line: lineNumber })
    const reference = referencePattern.exec(prose)
    if (reference) links.push({ target: reference[1], line: lineNumber })
  })
  return links
}

function findMarkdownFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) findMarkdownFiles(fullPath, files)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files
}

function decode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Checks every Markdown file under root and returns the broken links and the counts checked. */
export function checkLinks(root) {
  const files = findMarkdownFiles(root).sort()
  const headingCache = new Map()
  const headingsOf = (file) => {
    if (!headingCache.has(file)) headingCache.set(file, new Set(collectHeadings(readFileSync(file, 'utf8'))))
    return headingCache.get(file)
  }

  const problems = []
  let linkCount = 0
  for (const file of files) {
    const relativeFile = path.relative(root, file).split(path.sep).join('/')
    for (const { target: rawTarget, line } of collectLinks(readFileSync(file, 'utf8'))) {
      const target = rawTarget.replace(/^<(.*)>$/, '$1')
      if (!target || target.startsWith('//') || schemePattern.test(target)) continue
      linkCount++

      const hashIndex = target.indexOf('#')
      const targetPath = decode(hashIndex < 0 ? target : target.slice(0, hashIndex))
      const anchor = hashIndex < 0 ? undefined : decode(target.slice(hashIndex + 1)).toLowerCase()
      const resolved = !targetPath
        ? file
        : targetPath.startsWith('/')
          ? path.join(root, targetPath)
          : path.resolve(path.dirname(file), targetPath)
      const report = (reason) => problems.push({ file: relativeFile, line, target: rawTarget, reason })

      if (!existsSync(resolved)) {
        report('file not found')
        continue
      }
      if (anchor && statSync(resolved).isFile() && !headingsOf(resolved).has(anchor)) {
        const targetName = path.relative(root, resolved).split(path.sep).join('/')
        report(`anchor '#${anchor}' not found in ${targetName}`)
      }
    }
  }

  problems.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { problems, linkCount, fileCount: files.length }
}

function main(args) {
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : scriptRoot
  const { problems, linkCount, fileCount } = checkLinks(root)
  for (const { file, line, target, reason } of problems) {
    process.stderr.write(`${file}:${line}: broken link '${target}': ${reason}\n`)
  }
  if (problems.length > 0) return 1
  console.log(`Checked ${linkCount} links in ${fileCount} Markdown files.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
