// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { Backend } from './separation/backend'
import { isOutOfMemory, openOnBackend, SessionFault } from './session-backend'

// A stand-in for opening a session, which records each backend it was asked
// for and fails on the backends in `failing` with `error`.
function opener(failing: readonly Backend[], error: unknown = new Error('no kernel')) {
  const tried: Backend[] = []
  const open = async (backend: Backend) => {
    tried.push(backend)
    if (failing.includes(backend)) throw error
    return `session on ${backend}`
  }
  return { tried, open }
}

const adapter = (found: boolean) => async () => found

// What `promise` rejected with.
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe('opening a session in measurement mode', () => {
  test('on WebGPU that fails to open throws the model reason, without trying WebAssembly', async () => {
    const { tried, open } = opener(['webgpu'])
    const fault = await rejection(openOnBackend('webgpu', true, adapter(true), open))
    expect(fault).toBeInstanceOf(SessionFault)
    expect((fault as SessionFault).problem).toBe('model')
    expect(tried).toEqual(['webgpu'])
  })

  test('on WebGPU with no GPU adapter throws the WebGPU-not-available reason, without opening', async () => {
    const { tried, open } = opener([])
    const fault = await rejection(openOnBackend('webgpu', true, adapter(false), open))
    expect(fault).toBeInstanceOf(SessionFault)
    expect((fault as SessionFault).problem).toBe('webgpu-unavailable')
    expect(tried).toEqual([])
  })

  test('on WebGPU opens there when it can', async () => {
    const { tried, open } = opener([])
    expect(await openOnBackend('webgpu', true, adapter(true), open)).toEqual({
      backend: 'webgpu',
      session: 'session on webgpu',
    })
    expect(tried).toEqual(['webgpu'])
  })

  test('on WebAssembly that fails to open throws the model reason', async () => {
    const { tried, open } = opener(['wasm'])
    const fault = await rejection(openOnBackend('wasm', true, adapter(true), open))
    expect((fault as SessionFault).problem).toBe('model')
    expect(tried).toEqual(['wasm'])
  })

  test('throws the out-of-memory reason for a RangeError', async () => {
    const { open } = opener(['webgpu'], new RangeError('Array buffer allocation failed'))
    const fault = await rejection(openOnBackend('webgpu', true, adapter(true), open))
    expect((fault as SessionFault).problem).toBe('out-of-memory')
  })

  test("throws a fault without the error's text", async () => {
    const { open } = opener(['wasm'], new Error('Mưa rơi'))
    const fault = (await rejection(openOnBackend('wasm', true, adapter(true), open))) as SessionFault
    expect(fault.message).toBe('')
    expect(JSON.stringify(fault)).not.toContain('Mưa')
  })
})

describe('opening a session outside measurement mode', () => {
  test('on WebGPU that fails to open opens on WebAssembly instead', async () => {
    const { tried, open } = opener(['webgpu'])
    expect(await openOnBackend('webgpu', false, adapter(true), open)).toEqual({
      backend: 'wasm',
      session: 'session on wasm',
    })
    expect(tried).toEqual(['webgpu', 'wasm'])
  })

  test('on WebAssembly that fails to open throws the error unchanged', async () => {
    const error = new Error('no kernel')
    const { open } = opener(['wasm'], error)
    expect(await rejection(openOnBackend('wasm', false, adapter(true), open))).toBe(error)
  })
})

describe('an out-of-memory error', () => {
  test('is a RangeError', () => {
    expect(isOutOfMemory(new RangeError())).toBe(true)
  })

  test.each(['Out of memory', 'OOM while creating a buffer', 'allocation failed'])(
    'is an error saying "%s"',
    (text) => {
      expect(isOutOfMemory(new Error(text))).toBe(true)
    },
  )

  test('is not any other error', () => {
    expect(isOutOfMemory(new Error('Zoom failed'))).toBe(false)
    expect(isOutOfMemory('out of memory')).toBe(false)
  })
})
