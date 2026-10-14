import { Backend } from './separation/backend'

// Why a session could not open in measurement mode: the browser gave no GPU
// adapter, the backend could not load the model, or it ran out of memory.
export type SessionProblem = 'webgpu-unavailable' | 'model' | 'out-of-memory'

// A session that could not open in measurement mode. It has no text, so no
// error's text can reach the page.
export class SessionFault extends Error {
  constructor(readonly problem: SessionProblem) {
    super()
  }
}

// Whether an error looks like running out of memory. ONNX Runtime has no
// error type of its own for it, so this is a best guess from the error's type
// or text. The text is only matched here, never sent on.
export function isOutOfMemory(error: unknown): boolean {
  if (error instanceof RangeError) return true
  return error instanceof Error && /out of memory|\bOOM\b|allocation failed/i.test(error.message)
}

// Opens a session with `open` on `backend`. In measurement mode it never
// switches backend: a session that cannot open throws a SessionFault naming
// why. Otherwise `backend` is only a first choice: a session that fails to
// open on WebGPU is opened on WebAssembly instead. `backend` in the result is
// always the one the session runs on.
export async function openOnBackend<S>(
  backend: Backend,
  measuring: boolean,
  adapterFound: () => Promise<boolean>,
  open: (backend: Backend) => Promise<S>,
): Promise<{ backend: Backend; session: S }> {
  if (measuring) {
    if (backend === 'webgpu' && !(await adapterFound())) throw new SessionFault('webgpu-unavailable')
    try {
      return { backend, session: await open(backend) }
    } catch (error) {
      throw new SessionFault(isOutOfMemory(error) ? 'out-of-memory' : 'model')
    }
  }
  if (backend === 'webgpu') {
    try {
      return { backend, session: await open(backend) }
    } catch {
      // The GPU cannot run this model, so the slower CPU runs it.
    }
  }
  return { backend: 'wasm', session: await open('wasm') }
}
