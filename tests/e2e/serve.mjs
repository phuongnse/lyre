// A static server for the built web client, with no dependencies.
// It serves web/dist at / and at /lyre/, the sub-path GitHub Pages uses.
// Usage: node serve.mjs <port>
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../web/dist/', import.meta.url))
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

createServer(async (request, response) => {
  const file = fileFor(new URL(request.url ?? '/', 'http://localhost').pathname)
  const type = file === null ? undefined : types[extname(file)]
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
