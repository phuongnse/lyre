// The aligner's sample rate.
const SAMPLE_RATE = 16_000

// Test audio for alignment: a 0.5-amplitude 440 Hz sine, 16 kHz mono. The
// default 40 s is two of the core's windows, so a run covers the frame join.
export function testAudio(seconds = 40): Float32Array {
  const audio = new Float32Array(seconds * SAMPLE_RATE)
  for (let i = 0; i < audio.length; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)
  return audio
}
