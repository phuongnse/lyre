import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryPeak, readMemory, StageMemory, watchStage, watchWasmMemories } from './memory'

afterEach(() => vi.unstubAllGlobals())

describe('the memory peak', () => {
  test('keeps the highest of its samples for each figure', () => {
    const samples: StageMemory[] = [
      { wasmBytes: 100, heapBytes: 30 },
      { wasmBytes: 300, heapBytes: 10 },
      { wasmBytes: 200, heapBytes: 20 },
    ]
    const peak = new MemoryPeak(() => samples.shift()!)
    expect(peak.peak()).toEqual({})
    peak.sample()
    peak.sample()
    peak.sample()
    expect(peak.peak()).toEqual({ wasmBytes: 300, heapBytes: 30 })
  })

  test('gives no heap figure when the browser gives none', () => {
    const peak = new MemoryPeak(() => ({ wasmBytes: 5 }))
    peak.sample()
    expect(peak.peak()).toEqual({ wasmBytes: 5 })
  })
})

describe('reading the memory', () => {
  test('gives no heap figure when performance.memory is absent', () => {
    vi.stubGlobal('performance', {})
    expect(readMemory(() => 65_536)).toEqual({ wasmBytes: 65_536 })
  })

  test('gives the used heap when performance.memory is there, and no WebAssembly figure for a total of 0', () => {
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 1234 } })
    expect(readMemory(() => 0)).toEqual({ heapBytes: 1234 })
  })
})

describe('the WebAssembly memories', () => {
  test('count a memory made after the watch starts', () => {
    const total = watchWasmMemories()
    const before = total()
    const memory = new WebAssembly.Memory({ initial: 1 })
    expect(total() - before).toBe(65_536)
    memory.grow(1)
    expect(total() - before).toBe(2 * 65_536)
  })

  test('count a memory a module exports', async () => {
    const total = watchWasmMemories()
    const before = total()
    // (module (memory (export "memory") 2))
    const bytes = Uint8Array.of(
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      5,
      3,
      1,
      0,
      2,
      7,
      10,
      1,
      6,
      109,
      101,
      109,
      111,
      114,
      121,
      2,
      0,
    )
    await WebAssembly.instantiate(bytes)
    expect(total() - before).toBe(2 * 65_536)
  })
})

describe('watching a stage', () => {
  test('samples at the start, when the work asks and at the end, and gives the highest', async () => {
    const samples: StageMemory[] = [{ wasmBytes: 1 }, { wasmBytes: 9 }, { wasmBytes: 4 }]
    const { result, memory } = await watchStage(
      () => samples.shift() ?? { wasmBytes: 0 },
      async (sample) => {
        sample()
        return 'done'
      },
    )
    expect(result).toBe('done')
    expect(memory).toEqual({ wasmBytes: 9 })
  })
})
