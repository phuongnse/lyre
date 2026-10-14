// The memory a stage of a measurement used, in bytes, as the browser reports
// it (docs/reference/models.md#memory). A figure the browser does not give is
// left out.
export type StageMemory = { wasmBytes?: number; heapBytes?: number }

const memories = new Set<WebAssembly.Memory>()
let watching = false

// Starts counting every WebAssembly memory made in this worker, and gives a
// function for their total size in bytes. ONNX Runtime Web has no public way
// to read its memory, so this wraps WebAssembly.Memory and the two ways to
// instantiate a module, which find the memories a module exports or imports.
// It wraps once, and must run before the modules load.
export function watchWasmMemories(): () => number {
  if (!watching) {
    watching = true
    const Native = WebAssembly.Memory
    class Counted extends Native {
      constructor(descriptor: WebAssembly.MemoryDescriptor) {
        super(descriptor)
        memories.add(this)
      }
    }
    WebAssembly.Memory = Counted
    const collect = (instance: WebAssembly.Instance | undefined, imports: WebAssembly.Imports | undefined) => {
      for (const group of [instance?.exports, ...Object.values(imports ?? {})]) {
        for (const value of Object.values(group ?? {})) if (value instanceof Native) memories.add(value)
      }
    }
    type Created = WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource
    const instanceOf = (created: Created) => ('instance' in created ? created.instance : created)
    const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
      source: BufferSource | WebAssembly.Module,
      imports?: WebAssembly.Imports,
    ) => Promise<Created>
    WebAssembly.instantiate = (async (source: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) => {
      const created = await instantiate(source, imports)
      collect(instanceOf(created), imports)
      return created
    }) as typeof WebAssembly.instantiate
    const streaming = WebAssembly.instantiateStreaming?.bind(WebAssembly)
    if (streaming) {
      WebAssembly.instantiateStreaming = async (source, imports) => {
        const created = await streaming(source, imports)
        collect(created.instance, imports)
        return created
      }
    }
  }
  return () => {
    let total = 0
    for (const memory of memories) total += memory.buffer.byteLength
    return total
  }
}

// The memory now. `wasm` gives the total size of the WebAssembly memories. The
// JavaScript heap comes from performance.memory, which only Chromium-based
// browsers have. A total of 0 means none was found, so it is not reported.
export function readMemory(wasm: () => number): StageMemory {
  const wasmBytes = wasm()
  const heapBytes = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  return {
    ...(wasmBytes > 0 && { wasmBytes }),
    ...(heapBytes !== undefined && { heapBytes }),
  }
}

// The highest value of each figure over the samples taken.
export class MemoryPeak {
  private highest: StageMemory = {}

  constructor(private readonly read: () => StageMemory) {}

  sample(): void {
    const now = this.read()
    const { wasmBytes, heapBytes } = this.highest
    this.highest = {
      ...(now.wasmBytes !== undefined || wasmBytes !== undefined
        ? { wasmBytes: Math.max(now.wasmBytes ?? 0, wasmBytes ?? 0) }
        : {}),
      ...(now.heapBytes !== undefined || heapBytes !== undefined
        ? { heapBytes: Math.max(now.heapBytes ?? 0, heapBytes ?? 0) }
        : {}),
    }
  }

  peak(): StageMemory {
    return this.highest
  }
}

// How often a stage's memory is sampled while it works, in milliseconds.
const SAMPLE_EVERY_MS = 100

// Runs `work` and gives its result with the highest memory seen. It samples at
// the start, at an interval, whenever `work` calls the function it is given,
// and at the end. The interval only fires while `work` waits, so `work` also
// samples between its own steps.
export async function watchStage<T>(
  read: () => StageMemory,
  work: (sample: () => void) => Promise<T>,
): Promise<{ result: T; memory: StageMemory }> {
  const peak = new MemoryPeak(read)
  const sample = () => peak.sample()
  sample()
  const timer = setInterval(sample, SAMPLE_EVERY_MS)
  try {
    const result = await work(sample)
    sample()
    return { result, memory: peak.peak() }
  } finally {
    clearInterval(timer)
  }
}
