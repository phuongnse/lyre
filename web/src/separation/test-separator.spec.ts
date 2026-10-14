// @vitest-environment node
import { readFileSync } from 'node:fs'
import { env, InferenceSession, Tensor } from 'onnxruntime-web/webgpu'
import { expect, test } from 'vitest'

const SHAPE = [1, 4, 1025, 801]
const LENGTH = SHAPE.reduce((product, size) => product * size, 1)

test('the test separator on WebAssembly gives its input times 0.5 as stems', async () => {
  env.wasm.numThreads = 1
  env.wasm.proxy = false
  env.wasm.wasmBinary = readFileSync(
    new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url),
  )
  const graph = readFileSync(new URL('../../../tests/fixtures/models/mel-roformer.onnx', import.meta.url))
  const session = await InferenceSession.create(graph, { executionProviders: ['wasm'] })
  try {
    const mix = new Float32Array(LENGTH)
    for (let i = 0; i < LENGTH; i++) mix[i] = ((i * 7919) % 2001) / 1000 - 1
    const outputs = await session.run({ mix_spec: new Tensor('float32', mix, SHAPE) })
    const stems = outputs['stems_spec']
    expect(stems.type).toBe('float32')
    expect(stems.dims).toEqual(SHAPE)
    const data = stems.data as Float32Array
    let mismatches = 0
    for (let i = 0; i < LENGTH; i++) if (data[i] !== mix[i] * 0.5) mismatches++
    expect(mismatches).toBe(0)
    stems.dispose()
  } finally {
    await session.release()
  }
}, 120_000)
