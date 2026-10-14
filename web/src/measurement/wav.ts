// Turns a track, planar stereo at `rate` (the left channel, then the right),
// into a 16-bit PCM WAV file the page's audio players can play. Samples beyond
// full scale are clipped, which only affects listening.
export function wavFile(planar: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const frames = planar.length / 2
  const dataBytes = frames * 2 * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  // PCM, two channels.
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, rate, true)
  // Bytes a second, and bytes a frame.
  view.setUint32(28, rate * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)
  // The samples interleave, left then right in each frame.
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const sample = planar[channel * frames + frame]!
      const value = Math.round(Math.max(-1, Math.min(1, sample)) * 32767)
      view.setInt16(44 + frame * 4 + channel * 2, value, true)
    }
  }
  return bytes
}
