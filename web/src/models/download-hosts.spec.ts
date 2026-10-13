// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { initSync, pinnedFiles } from '../lyre-wasm/lyre_wasm.js'
import { REDIRECT_HOSTS } from './download-hosts'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

// The sources of the connect-src directive in the page's policy.
function connectSources(): string[] {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1]
  const directive = policy
    ?.split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src')
  if (!directive) throw new Error('The page has no connect-src.')
  return directive.slice(1)
}

test("connect-src allows only 'self', the pinned URLs' hosts and the hosts they redirect to", () => {
  const files = pinnedFiles()
  // The test entries' relative URLs are on the page's own origin, which 'self' covers.
  const pinnedHosts = files.filter((file) => /^https:\/\//.test(file.url)).map((file) => new URL(file.url).host)
  for (const file of files) file.free()
  expect(pinnedHosts.length).toBeGreaterThan(0)

  const sources = connectSources()
  expect(new Set(sources).size).toBe(sources.length)
  expect(new Set(sources)).toEqual(
    new Set(["'self'", ...[...pinnedHosts, ...REDIRECT_HOSTS].map((host) => `https://${host}`)]),
  )
})
