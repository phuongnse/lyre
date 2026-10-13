// Where ONNX Runtime Web runs a model: on the GPU through WebGPU, or on the
// CPU through WebAssembly with one thread (docs/architecture.md#processing).
export type Backend = 'webgpu' | 'wasm'

// The backend to open a session on. A forced backend wins. Otherwise WebGPU
// is used when the browser gave a GPU adapter.
export function chooseBackend(forced: Backend | undefined, adapterFound: boolean): Backend {
  if (forced !== undefined) return forced
  return adapterFound ? 'webgpu' : 'wasm'
}
