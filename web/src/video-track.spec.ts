// @vitest-environment node
import {
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Output,
  WEBM,
  WebMOutputFormat,
} from 'mediabunny'
import { describe, expect, test } from 'vitest'
import { MAX_SEGMENT_BYTES, PackagedTrack, PackageError } from './original-track'
import { KeyframeGroups, checkVideoEnd, packageVideo, videoRefusal } from './video-track'

const VP9 = 'video/webm; codecs="vp09.00.10.08"'

// A synthetic packet: its bytes are distinct, so a moved or changed packet shows.
interface Made {
  timestamp: number
  key: boolean
  data: Uint8Array
}

// The start of a VP9 frame header, key or delta, then bytes that differ per packet.
function packetBytes(index: number, key: boolean): Uint8Array {
  const header = key ? [0x82, 0x49, 0x83, 0x42] : [0x86]
  const body = new Uint8Array(32).map((_, i) => (index * 7 + i * 13 + 1) % 256)
  return new Uint8Array([...header, ...body])
}

const sameTime = (a: number, b: number) => Math.round(a * 1e6) === Math.round(b * 1e6)

// Writes a 16×16 VP9 WebM with a frame every `frameStep` seconds from `start`
// until before `end`. The frames at `keyframesAt` are keyframes.
async function makeVideo(
  keyframesAt: number[],
  frameStep: number,
  start: number,
  end: number,
): Promise<{ bytes: Uint8Array; packets: Made[] }> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
  const source = new EncodedVideoPacketSource('vp9')
  output.addVideoTrack(source)
  await output.start()
  const packets: Made[] = []
  for (let index = 0; start + index * frameStep < end - 1e-9; index++) {
    const timestamp = start + index * frameStep
    const key = keyframesAt.some((at) => sameTime(at, timestamp))
    const data = packetBytes(index, key)
    packets.push({ timestamp, key, data })
    await source.add(
      new EncodedPacket(data, key ? 'key' : 'delta', timestamp, frameStep),
      index === 0 ? { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 } } : undefined,
    )
  }
  await output.finalize()
  return { bytes: new Uint8Array(output.target.buffer!), packets }
}

async function packageBytes(bytes: Uint8Array, storedType: string): Promise<PackagedTrack | null> {
  return packageVideo(new Blob([bytes as Uint8Array<ArrayBuffer>]), storedType)
}

function joined(track: PackagedTrack): Uint8Array {
  const parts = [track.init, ...track.segments.map((segment) => segment.bytes)]
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    all.set(part, offset)
    offset += part.length
  }
  return all
}

// Reads the packaged track back as a player would, from its init and segments in order.
async function packetsOf(track: PackagedTrack): Promise<Made[]> {
  const input = new Input({ source: new BufferSource(joined(track)), formats: [MP4, WEBM] })
  try {
    const video = (await input.getPrimaryVideoTrack())!
    const packets: Made[] = []
    for await (const packet of new EncodedPacketSink(video).packets()) {
      packets.push({ timestamp: packet.timestamp, key: packet.type === 'key', data: packet.data.slice() })
    }
    return packets
  } finally {
    input.dispose()
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

const track = (startMs: number, durations: number[]): PackagedTrack => ({
  startMs,
  storedType: VP9,
  init: new Uint8Array([1]),
  segments: durations.map((durationMs) => ({ durationMs, bytes: new Uint8Array([1]) })),
})

describe('packageVideo', () => {
  test('a VP9 WebM starting at 1.5 s gives segments that start on keyframes, with the same packets shifted to 0', async () => {
    // A frame every 0.5 s and a keyframe every 2 s, from 1.5 s to 45.5 s.
    const keys = Array.from({ length: 22 }, (_, i) => 1.5 + i * 2)
    const source = await makeVideo(keys, 0.5, 1.5, 45.5)
    const packaged = (await packageBytes(source.bytes, VP9))!
    expect(packaged.storedType).toBe(VP9)
    expect(packaged.startMs).toBe(0)
    expect(packaged.segments.length).toBeGreaterThan(1)

    const keyStartsMs = new Set(keys.map((at) => Math.round((at - 1.5) * 1000)))
    let at = packaged.startMs
    for (const segment of packaged.segments) {
      expect(keyStartsMs.has(at)).toBe(true)
      expect(segment.durationMs).toBeGreaterThanOrEqual(1)
      expect(segment.durationMs).toBeLessThanOrEqual(20_000)
      // Every segment is whole Clusters.
      expect(hex(segment.bytes.subarray(0, 4))).toBe('1f43b675')
      at += segment.durationMs
    }
    expect(at).toBe(44_000)

    const found = await packetsOf(packaged)
    expect(found.length).toBe(source.packets.length)
    for (const [index, packet] of found.entries()) {
      const made = source.packets[index]!
      expect(packet.data).toEqual(made.data)
      expect(packet.key).toBe(made.key)
      expect(packet.timestamp).toBeCloseTo(made.timestamp - 1.5, 3)
    }
  })

  test('keyframes 21 s apart are refused with keyframe gap', async () => {
    const source = await makeVideo([0, 21], 1, 0, 23)
    const error = await rejection(packageBytes(source.bytes, VP9))
    expect(error).toBeInstanceOf(PackageError)
    expect((error as PackageError).message).toBe('keyframe gap')
  })

  test('an audio-only source gives no video', async () => {
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
    const audio = new EncodedAudioPacketSource('opus')
    output.addAudioTrack(audio)
    await output.start()
    for (let index = 0; index < 50; index++) {
      await audio.add(
        new EncodedPacket(new Uint8Array([index, 1, 2, 3]), 'key', index * 0.02, 0.02),
        index === 0 ? { decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } } : undefined,
      )
    }
    await output.finalize()
    expect(await packageBytes(new Uint8Array(output.target.buffer!), VP9)).toBeNull()
  })

  test('a stored type that is neither WebM nor MP4 video is refused', async () => {
    const source = await makeVideo([0], 0.5, 0, 2)
    expect(await rejection(packageBytes(source.bytes, 'audio/webm; codecs="opus"'))).toBeInstanceOf(PackageError)
  })

  test('a file that is not a source is refused with a PackageError', async () => {
    expect(await rejection(packageBytes(new Uint8Array([1, 2, 3]), VP9))).toBeInstanceOf(PackageError)
  })
})

describe('KeyframeGroups', () => {
  test('a group of exactly 67,108,864 bytes is accepted, and one byte more is refused', () => {
    const exact = new KeyframeGroups()
    exact.add(0, true, MAX_SEGMENT_BYTES - 10)
    exact.add(0.5, false, 10)
    // A keyframe starts a new group.
    exact.add(1, true, MAX_SEGMENT_BYTES)
    exact.finish(1.5)

    const over = new KeyframeGroups()
    over.add(0, true, MAX_SEGMENT_BYTES - 10)
    expect(() => over.add(0.5, false, 11)).toThrow(new PackageError('group too large'))
  })

  test('keyframes exactly 20 s apart are accepted, and more are refused', () => {
    const groups = new KeyframeGroups()
    groups.add(0, true, 1)
    groups.add(20, true, 1)
    groups.finish(40)
    expect(() => groups.finish(40.000001)).toThrow(new PackageError('keyframe gap'))

    const late = new KeyframeGroups()
    late.add(0, true, 1)
    expect(() => late.add(20.000001, false, 1)).toThrow(new PackageError('keyframe gap'))
  })

  test('a video that does not start on a keyframe is refused', () => {
    expect(() => new KeyframeGroups().add(0, false, 1)).toThrow(new PackageError('no first keyframe'))
    expect(() => new KeyframeGroups().finish(1)).toThrow(new PackageError('no first keyframe'))
  })
})

describe('checkVideoEnd', () => {
  test('a video ending 1,000 ms from the song is accepted, and 1,001 ms is refused', () => {
    expect(() => checkVideoEnd(track(0, [20_000, 1_000]), 20_000)).not.toThrow()
    expect(() => checkVideoEnd(track(20, [19_980]), 21_000)).not.toThrow()
    expect(() => checkVideoEnd(track(0, [20_000, 1_001]), 20_000)).toThrow(new PackageError('video length'))
    expect(() => checkVideoEnd(track(0, [18_999]), 20_000)).toThrow(new PackageError('video length'))
  })
})

describe('videoRefusal', () => {
  test('only the two video refusals give a code', () => {
    expect(videoRefusal(new PackageError('keyframe gap'))).toBe('keyframe gap')
    expect(videoRefusal(new PackageError('group too large'))).toBe('group too large')
    expect(videoRefusal(new PackageError('segment size'))).toBeUndefined()
    expect(videoRefusal(new Error('keyframe gap'))).toBeUndefined()
    expect(videoRefusal('keyframe gap')).toBeUndefined()
  })
})
