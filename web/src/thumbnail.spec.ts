import { describe, expect, test } from 'vitest'
import { JPEG_QUALITIES, MAX_THUMBNAIL_BYTES, fitWithin, smallEnoughJpeg } from './thumbnail'

describe('fitWithin', () => {
  test.each([
    [1920, 1080, 640, 360],
    [1000, 1000, 360, 360],
    [64, 36, 64, 36],
    [360, 1000, 130, 360],
  ])('%i×%i fits as %i×%i', (width, height, fittedWidth, fittedHeight) => {
    expect(fitWithin(width, height)).toEqual({ width: fittedWidth, height: fittedHeight })
  })

  test('a very thin image keeps at least one pixel on each side', () => {
    expect(fitWithin(10_000, 1)).toEqual({ width: 640, height: 1 })
  })
})

describe('smallEnoughJpeg', () => {
  // A fake encoder whose output shrinks with the quality: 1000 bytes per tenth.
  function encoder(sizeAt: (quality: number) => number) {
    const calls: number[] = []
    const encode = (quality: number) => {
      calls.push(quality)
      return Promise.resolve(new Blob([new Uint8Array(sizeAt(quality)).fill(Math.round(quality * 10))]))
    }
    return { calls, encode }
  }

  test('returns the first quality that fits and stops there', async () => {
    const { calls, encode } = encoder((quality) => Math.round(quality * 10) * 1000)
    const bytes = await smallEnoughJpeg(encode, 5_000)
    expect(calls).toEqual([0.9, 0.8, 0.7, 0.6, 0.5])
    expect(bytes).toEqual(new Uint8Array(5_000).fill(5))
  })

  test('keeps the best quality when it fits the 1 MiB limit', async () => {
    const { calls, encode } = encoder(() => MAX_THUMBNAIL_BYTES)
    expect((await smallEnoughJpeg(encode))?.length).toBe(MAX_THUMBNAIL_BYTES)
    expect(calls).toEqual([0.9])
  })

  test('returns null when even the lowest quality is too large', async () => {
    const { calls, encode } = encoder(() => MAX_THUMBNAIL_BYTES + 1)
    expect(await smallEnoughJpeg(encode)).toBeNull()
    expect(calls).toEqual(JPEG_QUALITIES)
  })

  test('returns null for an empty image', async () => {
    const { encode } = encoder(() => 0)
    expect(await smallEnoughJpeg(encode)).toBeNull()
  })
})
