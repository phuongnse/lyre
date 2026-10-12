// Checks how many bytes the Wiktionary word list adds to a WebAssembly module (D18).
//
// Usage: node scripts/word-list-size.mjs <with.wasm> <without.wasm>
//
// Compares the uncompressed sizes of the same module built with and without the list.
// Prints the bytes the list adds, and exits 1 when they are over LIMIT.
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// D18's limit of 500 KB, read as 500,000 bytes.
export const LIMIT = 500_000

/** The bytes the module at withPath has over the one at withoutPath. Throws when over limit. */
export function checkAddedSize(withPath, withoutPath, limit = LIMIT) {
  const added = statSync(withPath).size - statSync(withoutPath).size
  if (added > limit) {
    throw new Error(
      `The Wiktionary word list adds ${added} bytes to the WebAssembly module, over the limit of ${limit} bytes (D18).`,
    )
  }
  return added
}

function main(args) {
  const [withPath, withoutPath] = args
  if (withPath === undefined || withoutPath === undefined) {
    console.error('Usage: node scripts/word-list-size.mjs <with.wasm> <without.wasm>')
    return 1
  }
  try {
    const added = checkAddedSize(withPath, withoutPath)
    console.log(`The Wiktionary word list adds ${added} bytes to the WebAssembly module.`)
    return 0
  } catch (error) {
    console.error(error.message)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
