import { env, InferenceSession } from 'onnxruntime-web/webgpu'
import { Backend, chooseBackend } from './separation/backend'

// The WebAssembly file the WebGPU build of ONNX Runtime Web loads. The build
// copies it to ort/, so it comes from the site's own origin.
const ORT_WASM = 'ort/ort-wasm-simd-threaded.asyncify.wasm'

// The part of WebGPU this file uses. The TypeScript libraries do not declare it.
type Gpu = { requestAdapter(): Promise<unknown> }

async function adapterFound(): Promise<boolean> {
  const gpu = (navigator as { gpu?: Gpu }).gpu
  try {
    return (await gpu?.requestAdapter()) != null
  } catch {
    return false
  }
}

type ExternalData = { path: string; data: Uint8Array }[]

function open(graph: Uint8Array, backend: Backend, externalData?: ExternalData): Promise<InferenceSession> {
  return InferenceSession.create(graph, {
    executionProviders: [backend],
    ...(externalData && { externalData }),
  })
}

// Opens an ONNX Runtime session from a model's checked graph bytes, and the
// checked bytes of any files the graph names as its external data. It opens
// on WebGPU when the browser gives a GPU adapter and otherwise on WebAssembly
// with one thread. A session that fails to open on WebGPU is opened on
// WebAssembly instead. `backend` is always the one the session runs on.
export async function openSession(
  graph: Uint8Array,
  options: { baseUri: string; forced?: Backend; externalData?: ExternalData },
): Promise<{ backend: Backend; session: InferenceSession }> {
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  // Only the .wasm file is fetched. Its loader is part of this bundle.
  env.wasm.wasmPaths = { wasm: new URL(ORT_WASM, options.baseUri).href }
  const backend = chooseBackend(options.forced, options.forced === undefined && (await adapterFound()))
  if (backend === 'webgpu') {
    try {
      return { backend, session: await open(graph, backend, options.externalData) }
    } catch {
      // The GPU cannot run this model, so the slower CPU runs it.
    }
  }
  return { backend: 'wasm', session: await open(graph, 'wasm', options.externalData) }
}
