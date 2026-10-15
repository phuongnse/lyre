import { env, InferenceSession } from 'onnxruntime-web/webgpu'
import { adapterFound } from './gpu'
import { Backend, chooseBackend } from './separation/backend'
import { openOnBackend } from './session-backend'

// The WebAssembly file the WebGPU build of ONNX Runtime Web loads. The build
// copies it to ort/, so it comes from the site's own origin.
const ORT_WASM = 'ort/ort-wasm-simd-threaded.asyncify.wasm'

type ExternalData = { path: string; data: Uint8Array }[]

// Opens a session on a backend. Tests give their own.
export type SessionCreator = (
  graph: Uint8Array,
  backend: Backend,
  externalData?: ExternalData,
) => Promise<InferenceSession>

const open: SessionCreator = (graph, backend, externalData) =>
  InferenceSession.create(graph, {
    executionProviders: [backend],
    ...(externalData && { externalData }),
  })

// Opens an ONNX Runtime session from a model's checked graph bytes, and the
// checked bytes of any files the graph names as its external data. It opens
// on WebGPU when the browser gives a GPU adapter and otherwise on WebAssembly
// with one thread. A session that fails to open on WebGPU is opened on
// WebAssembly instead. `backend` is always the one the session runs on. In
// measurement mode, `forced` is required and the session opens on it or not
// at all: a session that cannot open throws a SessionFault naming why.
export async function openSession(
  graph: Uint8Array,
  options: {
    baseUri: string
    forced?: Backend
    measuring?: boolean
    externalData?: ExternalData
    create?: SessionCreator
  },
): Promise<{ backend: Backend; session: InferenceSession }> {
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  // Only the .wasm file is fetched. Its loader is part of this bundle.
  env.wasm.wasmPaths = { wasm: new URL(ORT_WASM, options.baseUri).href }
  const { forced, measuring = false } = options
  if (measuring && forced === undefined) throw new Error('A measurement names its backend.')
  // A measurement has its backend forced, so it never looks for an adapter here.
  const backend = forced ?? chooseBackend(undefined, await adapterFound())
  return openOnBackend(backend, measuring, adapterFound, (on) =>
    (options.create ?? open)(graph, on, options.externalData),
  )
}
