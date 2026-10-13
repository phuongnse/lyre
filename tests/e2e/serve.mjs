// A static server for the built web client, with no dependencies.
// It serves web/dist at / and at /lyre/, the sub-path GitHub Pages uses.
// It also serves the pinned test model files of tests/fixtures/models/ at
// test-models/ under both, where the test entries' URLs point. A release
// site has no such path.
// Usage: node serve.mjs <port>
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const testModels = fileURLToPath(new URL('../fixtures/models/', import.meta.url))
const port = Number(process.argv[2])

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

// The file under web/dist for a request path, or null when there is none.
function fileFor(urlPath) {
  let path
  try {
    path = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (path.startsWith('/lyre/')) path = path.slice('/lyre'.length)
  if (path.endsWith('/')) path += 'index.html'
  const file = join(root, path)
  // Reject paths that escape web/dist, such as /../secret.
  return file.startsWith(root) ? file : null
}

// Test model file paths: test-models/<name> at / and at /lyre/.
const testModelPath = /^(?:\/lyre)?\/test-models\/(.*)$/

// The file under tests/fixtures/models for an encoded file `name`, or null
// when the name is not a plain file name.
function testModelFor(name) {
  try {
    name = decodeURIComponent(name)
  } catch {
    return null
  }
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return join(testModels, name)
}

createServer(async (request, response) => {
  const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname
  const testModel = testModelPath.exec(urlPath)
  const file = testModel === null ? fileFor(urlPath) : testModelFor(testModel[1])
  const type = file === null ? undefined : testModel === null ? types[extname(file)] : 'application/octet-stream'
  if (file === null || type === undefined) {
    response.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': type }).end(body)
  } catch {
    response.writeHead(404).end()
  }
}).listen(port, '127.0.0.1')
