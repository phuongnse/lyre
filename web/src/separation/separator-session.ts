import { InferenceSession, Tensor } from 'onnxruntime-web/webgpu'
import { openSession, SessionCreator } from '../onnx-session'
import { Backend } from './backend'
import { SeparatorRunner } from './separate'

// The model's input and output shape, without a batch of more than 1
// (docs/reference/models.md#mel-band-roformer).
export const SPEC_SHAPE = [1, 4, 1025, 801]

// Opens a separator session from its checked file bytes, as openSession does,
// in measurement mode too. The file has no external data.
export function openSeparator(
  graph: Uint8Array,
  options: { baseUri: string; forced?: Backend; measuring?: boolean; create?: SessionCreator },
): Promise<{ backend: Backend; session: InferenceSession }> {
  return openSession(graph, options)
}

// Runs the separator on one segment: `spec` in the shape SPEC_SHAPE. It gives
// the output `stems_spec`, in the same shape (docs/reference/models.md#mel-band-roformer).
export async function runSegment(session: InferenceSession, spec: Float32Array): Promise<Tensor> {
  const outputs = await session.run({ mix_spec: new Tensor('float32', spec, SPEC_SHAPE) })
  return outputs['stems_spec']
}

// Runs the separator in an open session, one segment at a time, for `separate`.
export function separatorRunner(session: InferenceSession): SeparatorRunner {
  return async (spec) => {
    const stemsSpec = await runSegment(session, spec)
    return {
      vocalsSpec: stemsSpec.data as Float32Array,
      dispose() {
        stemsSpec.dispose()
      },
    }
  }
}
