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
  Mp4OutputFormat,
  Output,
  OutputFormat,
  WEBM,
  WebMOutputFormat,
} from 'mediabunny'
import { describe, expect, test } from 'vitest'
import {
  checkTrackLimits,
  groupSegments,
  MAX_CONTAINER_INIT_BYTES,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENTS,
  PackagedTrack,
  PackageError,
  packageOriginal,
  Piece,
} from './original-track'

const OPUS = 'audio/webm; codecs="opus"'
const AAC = 'audio/mp4; codecs="mp4a.40.2"'

// A synthetic packet: its bytes are distinct, so a moved or changed packet shows.
interface Made {
  timestamp: number
  data: Uint8Array
}

function packetBytes(index: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (index * 7 + i * 13 + 1) % 256)
}

// Writes `count` audio packets of `duration` seconds from `start`, and VP8
// video key packets at `videoAt`, into a source file.
async function makeSource(
  format: OutputFormat,
  audio: { codec: 'opus' | 'aac'; config: AudioDecoderConfig; start: number; duration: number; count: number },
  videoAt: number[] = [],
): Promise<{ bytes: Uint8Array; packets: Made[] }> {
  const output = new Output({ format, target: new BufferTarget() })
  const audioSource = new EncodedAudioPacketSource(audio.codec)
  output.addAudioTrack(audioSource)
  const videoSource = videoAt.length > 0 ? new EncodedVideoPacketSource('vp8') : undefined
  if (videoSource !== undefined) output.addVideoTrack(videoSource)
  await output.start()
  for (const [index, timestamp] of videoAt.entries()) {
    await videoSource!.add(
      new EncodedPacket(vp8KeyFrame(), 'key', timestamp, 1),
      index === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } } : undefined,
    )
  }
  const packets: Made[] = []
  for (let index = 0; index < audio.count; index++) {
    const timestamp = audio.start + index * audio.duration
    const data = packetBytes(index)
    packets.push({ timestamp, data })
    await audioSource.add(
      new EncodedPacket(data, 'key', timestamp, audio.duration),
      index === 0 ? { decoderConfig: audio.config } : undefined,
    )
  }
  await output.finalize()
  return { bytes: new Uint8Array(output.target.buffer!), packets }
}

// The start of a 16×16 VP8 keyframe: its frame tag, start code and size.
function vp8KeyFrame(): Uint8Array {
  return new Uint8Array([0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0])
}

const opusConfig: AudioDecoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }
const aacConfig: AudioDecoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 48000,
  numberOfChannels: 2,
  description: new Uint8Array([0x11, 0x90]),
}

// An Opus WebM with 20 ms packets from `start`, beside VP8 video at `videoAt`.
const opusWebm = (start: number, count: number, videoAt: number[] = []) =>
  makeSource(new WebMOutputFormat(), { codec: 'opus', config: opusConfig, start, duration: 0.02, count }, videoAt)

async function packageBytes(bytes: Uint8Array, storedType: string): Promise<PackagedTrack> {
  return packageOriginal(new Blob([bytes as Uint8Array<ArrayBuffer>]), storedType)
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
  const bytes = joined(track)
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4, WEBM] })
  try {
    const audio = (await input.getPrimaryAudioTrack())!
    const packets: Made[] = []
    for await (const packet of new EncodedPacketSink(audio).packets()) {
      packets.push({ timestamp: packet.timestamp, data: packet.data.slice() })
    }
    return packets
  } finally {
    input.dispose()
  }
}

function expectSamePackets(found: Made[], made: Made[], shift: number): void {
  expect(found.length).toBe(made.length)
  for (const [index, packet] of found.entries()) {
    expect(packet.data).toEqual(made[index]!.data)
    expect(packet.timestamp).toBeCloseTo(made[index]!.timestamp - shift, 3)
  }
}

// Each segment's start: the track's start plus the durations before it.
function segmentStarts(track: PackagedTrack): number[] {
  const starts: number[] = []
  let at = track.startMs
  for (const segment of track.segments) {
    starts.push(at)
    at += segment.durationMs
  }
  return starts
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

// The offset of the first copy of `needle` in `haystack`, or -1.
function indexOf(haystack: Uint8Array, needle: number[]): number {
  for (let offset = 0; offset + needle.length <= haystack.length; offset++) {
    if (needle.every((byte, i) => haystack[offset + i] === byte)) return offset
  }
  return -1
}

// Reads an EBML variable-size integer at `offset`: its length and its value.
function ebmlSize(bytes: Uint8Array, offset: number): { length: number; value: number } {
  const first = bytes[offset]!
  let length = 1
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++
  let value = first & (0xff >> length)
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!
  return { length, value }
}

// The types of the top-level boxes in MP4 bytes.
function boxTypes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const types: string[] = []
  for (let offset = 0; offset < bytes.length;) {
    const size = view.getUint32(offset)
    types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)))
    expect(size).toBeGreaterThanOrEqual(8)
    offset += size
  }
  return types
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

describe('packageOriginal', () => {
  test('an Opus WebM starting at 1.5 s gives a WebM track with the same packets, shifted to 0', async () => {
    // 3 s of 20 ms packets, so the track has several Clusters.
    const source = await opusWebm(1.5, 150)
    const track = await packageBytes(source.bytes, OPUS)
    expect(track.storedType).toBe(OPUS)
    expect(track.startMs).toBe(0)
    expectSamePackets(await packetsOf(track), source.packets, 1.5)
    expect(track.segments.reduce((sum, segment) => sum + segment.durationMs, 0)).toBe(3000)

    // The init is the EBML header and the Segment's header, without a Cluster.
    expect(hex(track.init.subarray(0, 4))).toBe('1a45dfa3')
    expect(indexOf(track.init, [0x1f, 0x43, 0xb6, 0x75])).toBe(-1)
    const scale = indexOf(track.init, [0x2a, 0xd7, 0xb1])
    expect(scale).toBeGreaterThan(0)
    const size = ebmlSize(track.init, scale + 3)
    let value = 0
    for (let i = 0; i < size.value; i++) value = value * 256 + track.init[scale + 3 + size.length + i]!
    expect(value).toBe(1_000_000)
    // Every segment is whole Clusters.
    for (const segment of track.segments) expect(hex(segment.bytes.subarray(0, 4))).toBe('1f43b675')
  })

  test('an AAC MP4 gives a fragmented MP4 track with the same packets', async () => {
    const frame = 1024 / 48000
    const source = await makeSource(new Mp4OutputFormat(), {
      codec: 'aac',
      config: aacConfig,
      start: 0,
      duration: frame,
      count: 150,
    })
    const track = await packageBytes(source.bytes, AAC)
    expect(track.storedType).toBe(AAC)
    expect(track.startMs).toBe(0)
    expectSamePackets(await packetsOf(track), source.packets, 0)

    expect(boxTypes(track.init)).toEqual(['ftyp', 'moov'])
    for (const segment of track.segments) {
      const types = boxTypes(segment.bytes)
      expect(types.length % 2).toBe(0)
      types.forEach((type, index) => expect(type).toBe(index % 2 === 0 ? 'moof' : 'mdat'))
    }
  })

  test('audio starting 21 ms after the video gives a track that starts at 21 ms', async () => {
    const source = await opusWebm(0.021, 100, [0, 1])
    const track = await packageBytes(source.bytes, OPUS)
    expect(track.startMs).toBe(21)
    expectSamePackets(await packetsOf(track), source.packets, 0)
    // The segments follow on from the start, and the last ends with the audio.
    const starts = segmentStarts(track)
    expect(starts[0]).toBe(21)
    const last = track.segments.length - 1
    expect(starts[last]! + track.segments[last]!.durationMs).toBe(2021)
  })

  test('audio starting 51 ms after the video is refused', async () => {
    const source = await opusWebm(0.051, 100, [0, 1])
    const error = await rejection(packageBytes(source.bytes, OPUS))
    expect(error).toBeInstanceOf(PackageError)
    expect((error as PackageError).message).toBe('audio starts late')
  })

  test('a stored type that is neither WebM nor MP4 is refused', async () => {
    const source = await opusWebm(0, 10)
    expect(await rejection(packageBytes(source.bytes, 'audio/ogg; codecs="opus"'))).toBeInstanceOf(PackageError)
  })

  test('a file that is not a source is refused with a PackageError', async () => {
    expect(await rejection(packageBytes(new Uint8Array([1, 2, 3]), OPUS))).toBeInstanceOf(PackageError)
  })
})

describe('groupSegments', () => {
  const piece = (startMs: number): Piece => ({ startMs, bytes: new Uint8Array([startMs % 256, 1]) })

  test('segments last 1 to 10,000 ms, follow on without gaps and start at a piece', () => {
    const pieces = Array.from({ length: 28 }, (_, i) => piece(i * 900))
    const { startMs, segments } = groupSegments(pieces, 25_000)
    expect(startMs).toBe(0)
    expect(segments.length).toBeGreaterThan(1)
    const pieceStarts = new Set(pieces.map((p) => p.startMs))
    let at = startMs
    for (const segment of segments) {
      expect(pieceStarts.has(at)).toBe(true)
      expect(segment.durationMs).toBeGreaterThanOrEqual(1)
      expect(segment.durationMs).toBeLessThanOrEqual(10_000)
      at += segment.durationMs
    }
    expect(at).toBe(25_000)
    // Each segment's bytes are its pieces' bytes in order.
    const all = segments.flatMap((segment) => [...segment.bytes])
    expect(all).toEqual(pieces.flatMap((p) => [...p.bytes]))
  })

  test('groups greedily up to 10 s', () => {
    const { segments } = groupSegments([piece(0), piece(5_000), piece(10_000), piece(15_000)], 20_000)
    expect(segments.map((segment) => segment.durationMs)).toEqual([10_000, 10_000])
  })

  test('the first piece may start at up to 50 ms', () => {
    expect(groupSegments([piece(50)], 1_000).startMs).toBe(50)
    expect(() => groupSegments([piece(51)], 1_000)).toThrow(PackageError)
  })

  test('a slightly negative first piece starts the track at 0', () => {
    const { startMs, segments } = groupSegments([piece(-7), piece(900)], 2_000)
    expect(startMs).toBe(0)
    expect(segments).toEqual([{ durationMs: 2_000, bytes: expect.any(Uint8Array) }])
  })

  test('a piece of exactly 10,000 ms is kept, and one of 10,001 ms is refused', () => {
    expect(groupSegments([piece(0), piece(10_000)], 11_000).segments.map((s) => s.durationMs)).toEqual([10_000, 1_000])
    expect(() => groupSegments([piece(0), piece(10_001)], 11_000)).toThrow(PackageError)
    expect(() => groupSegments([piece(0)], 10_001)).toThrow(PackageError)
  })

  test('a segment holds at most 67,108,864 bytes, and a larger piece is refused', () => {
    // The pieces share one buffer, so the test needs little more than 64 MiB.
    const buffer = new Uint8Array(MAX_SEGMENT_BYTES + 1)
    const half = buffer.subarray(0, MAX_SEGMENT_BYTES / 2)
    const pieces = [0, 100, 200].map((startMs, i) => ({ startMs, bytes: i < 2 ? half : buffer.subarray(0, 1) }))
    const { segments } = groupSegments(pieces, 1_000)
    expect(segments.map((segment) => segment.bytes.length)).toEqual([MAX_SEGMENT_BYTES, 1])
    expect(segments.map((segment) => segment.durationMs)).toEqual([200, 800])
    expect(() => groupSegments([{ startMs: 0, bytes: buffer }], 1_000)).toThrow(new PackageError('piece too large'))
  })

  test('video segments may last up to 20,000 ms, and a late video start names the video', () => {
    const { segments } = groupSegments([piece(0), piece(10_000), piece(20_000)], 30_000, 20_000, 'video')
    expect(segments.map((segment) => segment.durationMs)).toEqual([20_000, 10_000])
    expect(() => groupSegments([piece(51)], 1_000, 20_000, 'video')).toThrow(new PackageError('video starts late'))
  })

  test('pieces out of order, an end before the last piece, or no pieces are refused', () => {
    expect(() => groupSegments([piece(900), piece(0)], 2_000)).toThrow(PackageError)
    expect(() => groupSegments([piece(0), piece(900)], 900)).toThrow(PackageError)
    expect(() => groupSegments([], 1_000)).toThrow(PackageError)
  })
})

describe('checkTrackLimits', () => {
  test('a track at every limit is accepted', () => {
    expect(() => checkTrackLimits(MAX_CONTAINER_INIT_BYTES, [MAX_SEGMENT_BYTES])).not.toThrow()
    expect(() => checkTrackLimits(1, new Array<number>(MAX_SEGMENTS).fill(1))).not.toThrow()
  })

  test('init bytes over 65,536, or none, are refused', () => {
    expect(MAX_CONTAINER_INIT_BYTES).toBe(65_536)
    expect(() => checkTrackLimits(65_537, [1])).toThrow(PackageError)
    expect(() => checkTrackLimits(0, [1])).toThrow(PackageError)
  })

  test('a media segment over 67,108,864 bytes, or an empty one, is refused', () => {
    expect(MAX_SEGMENT_BYTES).toBe(67_108_864)
    expect(() => checkTrackLimits(1, [1, 67_108_865])).toThrow(PackageError)
    expect(() => checkTrackLimits(1, [1, 0])).toThrow(PackageError)
  })

  test('more than 4,096 segments, or none, are refused', () => {
    expect(MAX_SEGMENTS).toBe(4_096)
    expect(() => checkTrackLimits(1, new Array<number>(4_097).fill(1))).toThrow(PackageError)
    expect(() => checkTrackLimits(1, [])).toThrow(PackageError)
  })
})
