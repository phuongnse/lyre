// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { initSync, ModelCheck } from '../lyre-wasm/lyre_wasm.js'
import { FakeModelFiles } from './fake-model-files'
import { loadModel, ModelCheckFailed, ModelDeps, ModelDownloadFailed, ModelProgress } from './model-download'

// The 56-byte two-block test vector of FIPS 180-2, which test-two-block pins.
const twoBlock = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
const PIECE = 8
const BASE = 'http://localhost/lyre/'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../lyre-wasm/lyre_wasm_bg.wasm', import.meta.url)) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeFetch {
  fetch: typeof fetch
  requests: { input: unknown; init: RequestInit | undefined }[]
  // Each read the code made of a response body: false when it read the whole body at once.
  readWhole: boolean
}

// A fetch that answers with `bytes` as a stream of 8-byte pieces, or with `status`.
function fakeFetch(bytes: Uint8Array = twoBlock, status = 200): FakeFetch {
  const fake: FakeFetch = { requests: [], readWhole: false, fetch: undefined as unknown as typeof fetch }
  fake.fetch = (async (input: unknown, init?: RequestInit) => {
    fake.requests.push({ input, init })
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + PIECE))
        offset += PIECE
      },
    })
    const response = new Response(status === 200 ? body : null, { status })
    for (const whole of ['arrayBuffer', 'blob', 'text', 'json', 'bytes', 'formData'] as const) {
      ;(response as unknown as Record<string, unknown>)[whole] = () => {
        fake.readWhole = true
        throw new Error(`${whole}() reads the whole body.`)
      }
    }
    return response
  }) as typeof fetch
  return fake
}

function deps(files: FakeModelFiles, fake: FakeFetch, more: Partial<ModelDeps> = {}): ModelDeps {
  return { files, fetch: fake.fetch, baseUri: BASE, ...more }
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function changed(bytes: Uint8Array, at: number): Uint8Array {
  const copy = bytes.slice()
  copy[at] ^= 0x01
  return copy
}

test('the first load downloads the file, reports its progress in bytes and keeps it', async () => {
  const files = new FakeModelFiles()
  const fake = fakeFetch()
  const progress: ModelProgress[] = []

  const loaded = await loadModel('test-two-block', deps(files, fake, { onProgress: (p) => progress.push(p) }))

  expect(await bytesOf(loaded)).toEqual(twoBlock)
  expect(await bytesOf(files.files.get('test-two-block')!)).toEqual(twoBlock)
  expect(fake.requests).toHaveLength(1)
  expect(String(fake.requests[0].input)).toBe('http://localhost/lyre/test-models/two-block.bin')
  expect(progress.at(-1)).toEqual({ id: 'test-two-block', loadedBytes: 56, totalBytes: 56 })
  expect(progress.map((p) => p.loadedBytes)).toEqual([0, 8, 16, 24, 32, 40, 48, 56])
  expect(fake.readWhole).toBe(false)
})

test('a second load checks the kept file and downloads nothing', async () => {
  const files = new FakeModelFiles()
  const fake = fakeFetch()
  await loadModel('test-two-block', deps(files, fake))

  const loaded = await loadModel('test-two-block', deps(files, fake))

  expect(fake.requests).toHaveLength(1)
  expect(loaded).toBe(files.files.get('test-two-block'))
  expect(await bytesOf(loaded)).toEqual(twoBlock)
  expect(files.removed).toEqual([])
})

test('a kept file with one byte changed is removed on its next load and downloaded again', async () => {
  const files = new FakeModelFiles()
  files.files.set('test-two-block', new Blob([changed(twoBlock, 30) as Uint8Array<ArrayBuffer>]))
  const fake = fakeFetch()

  const loaded = await loadModel('test-two-block', deps(files, fake))

  expect(files.removed).toEqual(['test-two-block'])
  expect(files.calls.indexOf('remove test-two-block')).toBeLessThan(files.calls.indexOf('create test-two-block'))
  expect(fake.requests).toHaveLength(1)
  expect(await bytesOf(loaded)).toEqual(twoBlock)
  expect(await bytesOf(files.files.get('test-two-block')!)).toEqual(twoBlock)
})

test('a served file with one byte changed fails, is removed and is never returned', async () => {
  const files = new FakeModelFiles()
  const fake = fakeFetch(changed(twoBlock, 10))

  const loading = loadModel('test-two-block', deps(files, fake))

  await expect(loading).rejects.toThrow(ModelCheckFailed)
  await expect(loading).rejects.toMatchObject({ id: 'test-two-block' })
  expect(files.files.has('test-two-block')).toBe(false)
  expect(files.removed).toEqual(['test-two-block'])
  expect(files.calls).toContain('abort test-two-block')
  expect(files.calls).not.toContain('commit test-two-block')
})

test('a served file longer than its pin fails without being read to its end', async () => {
  const files = new FakeModelFiles()
  const fake = fakeFetch(new Uint8Array([...twoBlock, ...twoBlock]))

  await expect(loadModel('test-two-block', deps(files, fake))).rejects.toThrow(ModelCheckFailed)
  expect(files.files.has('test-two-block')).toBe(false)
  expect(files.pieces.reduce((total, piece) => total + piece.length, 0)).toBeLessThanOrEqual(56)
})

test('the download reaches the check and storage in pieces smaller than the file', async () => {
  const fed: number[] = []
  const feed = ModelCheck.prototype.feed
  vi.spyOn(ModelCheck.prototype, 'feed').mockImplementation(function (this: ModelCheck, piece: Uint8Array) {
    fed.push(piece.length)
    return feed.call(this, piece)
  })
  const files = new FakeModelFiles()
  const fake = fakeFetch()

  await loadModel('test-two-block', deps(files, fake))

  expect(files.pieces.length).toBeGreaterThanOrEqual(2)
  for (const piece of files.pieces) expect(piece.length).toBeLessThan(56)
  expect(fed.length).toBeGreaterThanOrEqual(2)
  for (const length of fed) expect(length).toBeLessThan(56)
  expect(fed.reduce((total, length) => total + length, 0)).toBe(56)
  expect(fake.readWhole).toBe(false)
})

test('the fetch sends no cookies, no referrer and no headers, after asking for persistent storage', async () => {
  const files = new FakeModelFiles(false)
  const fake = fakeFetch()
  const order: string[] = []
  const counted: typeof fetch = (input, init) => {
    order.push(`fetch after ${files.calls.join(', ')}`)
    return fake.fetch(input, init)
  }
  const mayBeCleared = vi.fn()

  await loadModel('test-two-block', { files, fetch: counted, baseUri: BASE, onMayBeCleared: mayBeCleared })

  expect(fake.requests).toHaveLength(1)
  expect(fake.requests[0].init).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  expect(fake.requests[0].init).not.toHaveProperty('headers')
  expect(order).toEqual(['fetch after get test-two-block, persisted, persist'])
  expect(mayBeCleared).toHaveBeenCalledOnce()
})

test('a granted persistent storage gives no note', async () => {
  const mayBeCleared = vi.fn()
  await loadModel('test-two-block', deps(new FakeModelFiles(true), fakeFetch(), { onMayBeCleared: mayBeCleared }))
  expect(mayBeCleared).not.toHaveBeenCalled()
})

test('an HTTP error fails the download and keeps nothing', async () => {
  const files = new FakeModelFiles()

  const loading = loadModel('test-two-block', deps(files, fakeFetch(twoBlock, 404)))

  await expect(loading).rejects.toThrow(ModelDownloadFailed)
  await expect(loading).rejects.toMatchObject({ id: 'test-two-block' })
  expect(files.files.size).toBe(0)
})

test('a lost connection fails the download, aborts the file and keeps nothing', async () => {
  const files = new FakeModelFiles()
  const broken: typeof fetch = async () => {
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('network error'))
          return
        }
        sent = true
        controller.enqueue(twoBlock.slice(0, PIECE))
      },
    })
    return new Response(body)
  }

  await expect(loadModel('test-two-block', deps(files, fakeFetch(), { fetch: broken }))).rejects.toThrow(
    ModelDownloadFailed,
  )
  expect(files.files.size).toBe(0)
  expect(files.calls).toContain('abort test-two-block')
  expect(files.removed).toEqual(['test-two-block'])
})

test('an unknown model is refused before any request', async () => {
  const fake = fakeFetch()
  await expect(loadModel('no-such-model', deps(new FakeModelFiles(), fake))).rejects.toThrow()
  expect(fake.requests).toHaveLength(0)
})
