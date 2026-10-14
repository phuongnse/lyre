import { InferenceSession, Tensor } from 'onnxruntime-web/webgpu'
import { AlignerKind, alignerRules } from '../lyre-wasm/lyre_wasm.js'
import { ModelRunner } from './align-song'

// The test aligners, tiny stand-ins for the real ones (docs/reference/models.md).
export type TestAligner = 'omnilingual' | 'lyric-alignment'

// Runs an aligner of the core's `kind` in an open session, one window at a
// time. The model's input and output names come from the core's rules for
// `kind`. The caller has loaded the core.
export function alignerRunner(session: InferenceSession, kind: AlignerKind): ModelRunner {
  const rules = alignerRules(kind)
  // Each getter copies the value out of the core, so each is read once.
  const inputName = rules.inputName
  const outputName = rules.outputName
  rules.free()
  return async (input) => {
    const outputs = await session.run({ [inputName]: new Tensor('float32', input, [1, input.length]) })
    const output = outputs[outputName]
    try {
      return (output.data as Float32Array).slice()
    } finally {
      output.dispose()
    }
  }
}
