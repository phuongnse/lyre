import { env, InferenceSession, Tensor } from 'onnxruntime-web/webgpu'
import { Backend, chooseBackend } from './backend'

// The name the graph gives its weights file (docs/reference/models.md#htdemucs).
const WEIGHTS_NAME = 'htdemucs_fwd.onnx.data'

// The WebAssembly file the WebGPU build of ONNX Runtime Web loads. The build
// copies it to ort/, so it comes from the site's own origin.
const ORT_WASM = 'ort/ort-wasm-simd-threaded.asyncify.wasm'

// The model's input shapes (docs/reference/models.md#htdemucs).
export const X_SHAPE = [1, 4, 2048, 336]
export const XT_SHAPE = [1, 2, 343_980]

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

function open(graph: Uint8Array, weights: Uint8Array, backend: Backend): Promise<InferenceSession> {
  return InferenceSession.create(graph, {
    executionProviders: [backend],
    externalData: [{ path: WEIGHTS_NAME, data: weights }],
  })
}

// Opens a separator session from its checked graph and weights bytes, on
// WebGPU when the browser gives a GPU adapter and otherwise on WebAssembly
// with one thread. A session that fails to open on WebGPU is opened on
// WebAssembly instead. `backend` is always the one the session runs on.
export async function openSeparator(
  graph: Uint8Array,
  weights: Uint8Array,
  options: { baseUri: string; forced?: Backend },
): Promise<{ backend: Backend; session: InferenceSession }> {
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  // Only the .wasm file is fetched. Its loader is part of this bundle.
  env.wasm.wasmPaths = { wasm: new URL(ORT_WASM, options.baseUri).href }
  const backend = chooseBackend(options.forced, options.forced === undefined && (await adapterFound()))
  if (backend === 'webgpu') {
    try {
      return { backend, session: await open(graph, weights, backend) }
    } catch {
      // The GPU cannot run this model, so the slower CPU runs it.
    }
  }
  return { backend: 'wasm', session: await open(graph, weights, 'wasm') }
}

// Runs the separator on one window: `x` in the shape X_SHAPE and `xt` in the shape XT_SHAPE.
export async function runWindow(
  session: InferenceSession,
  x: Float32Array,
  xt: Float32Array,
): Promise<{ xOut: Tensor; xtOut: Tensor }> {
  const outputs = await session.run({ x: new Tensor('float32', x, X_SHAPE), xt: new Tensor('float32', xt, XT_SHAPE) })
  return { xOut: outputs['x_out'], xtOut: outputs['xt_out'] }
}
