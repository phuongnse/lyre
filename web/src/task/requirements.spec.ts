// @vitest-environment node
import { describe, expect, test } from 'vitest'
import { unmetRequirements } from './requirements'

describe('the requirements for making songs', () => {
  test('are unmet for WebGPU when there is no adapter', () => {
    expect(unmetRequirements({ adapterFound: false, memoryGb: 8 })).toEqual(['webgpu'])
  })

  test('are unmet for memory below 8 GB', () => {
    expect(unmetRequirements({ adapterFound: true, memoryGb: 4 })).toEqual(['memory'])
  })

  test('name both when both are unmet', () => {
    expect(unmetRequirements({ adapterFound: false, memoryGb: 4 })).toEqual(['webgpu', 'memory'])
  })

  test.each([8, 16])('are met with an adapter and %d GB', (memoryGb) => {
    expect(unmetRequirements({ adapterFound: true, memoryGb })).toEqual([])
  })

  test('are met when the browser does not report memory', () => {
    expect(unmetRequirements({ adapterFound: true })).toEqual([])
  })
})
