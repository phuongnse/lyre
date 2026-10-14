import { expect, test } from 'vitest'
import { wavFile } from './wav'

const hex = (text: string) => Uint8Array.from(text.trim().split(/\s+/), (byte) => parseInt(byte, 16))

test('a planar stereo track gives the known WAV file', () => {
  // The left channel [0, 0.5, 1.5], then the right [-1, -0.25, 0]. 1.5 is clipped to full scale.
  const planar = Float32Array.of(0, 0.5, 1.5, -1, -0.25, 0)
  const expected = hex(`
    52 49 46 46 30 00 00 00 57 41 56 45 66 6D 74 20
    10 00 00 00 01 00 02 00 44 AC 00 00 10 B1 02 00
    04 00 10 00 64 61 74 61 0C 00 00 00
    00 00 01 80 00 40 00 E0 FF 7F 00 00
  `)
  expect(expected).toHaveLength(56)
  expect(wavFile(planar, 44_100)).toEqual(expected)
})

test('1 s of 44.1 kHz stereo gives the header and 176,400 bytes of samples', () => {
  expect(wavFile(new Float32Array(2 * 44_100), 44_100)).toHaveLength(44 + 176_400)
})
