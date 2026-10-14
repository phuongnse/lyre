import { InferenceSession, Tensor } from 'onnxruntime-web/webgpu'
import { openSession } from '../onnx-session'
import { Backend } from './backend'

// The name the graph gives its weights file (docs/reference/models.md#htdemucs).
const WEIGHTS_NAME = 'htdemucs_fwd.onnx.data'

// The model's input shapes (docs/reference/models.md#htdemucs).
export const X_SHAPE = [1, 4, 2048, 336]
export const XT_SHAPE = [1, 2, 343_980]

// Opens a separator session from its checked graph and weights bytes, as
// openSession does, in measurement mode too.
export function openSeparator(
  graph: Uint8Array,
  weights: Uint8Array,
  options: { baseUri: string; forced?: Backend; measuring?: boolean },
): Promise<{ backend: Backend; session: InferenceSession }> {
  return openSession(graph, { ...options, externalData: [{ path: WEIGHTS_NAME, data: weights }] })
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
