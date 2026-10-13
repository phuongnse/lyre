import { BlobSource, Input, InputTrack, MP3, MP4, MediaCodec, MetadataTags, WEBM } from 'mediabunny'
import { storedType } from './lyre-wasm/lyre_wasm.js'
import { SourceError } from './source-error'

export { SourceError, type SourceProblem } from './source-error'

// Reads a source's details: stage 1 of processing
// (docs/domain/knowledge.md#processing). It only reads the container, through
// Mediabunny, and decodes nothing. It also checks that this browser can play
// the stored type the core gives each track (D24). The source is never changed
// or sent anywhere.

// Times are in seconds. The duration counts from zero, so a timeline that
// starts late has a start offset above zero. Tags are exactly as stored, and a
// missing or empty tag is absent.
export interface SourceDetails {
  duration: number
  startOffset: number
  hasVideo: boolean
  title?: string
  artist?: string
  composer?: string
  // Set when this browser cannot play a track, so a song cannot be made from it.
  cannotPlay?: CannotPlay
  // The stored type the core gives the primary audio track, even when this
  // browser cannot play it. Absent when the core gives none.
  audioType?: string
  // The same for the primary video track. Absent too when there is no video.
  videoType?: string
}

export type SourceTrack = 'video' | 'audio'

// A track's codec, as Mediabunny names it, and its codec string. Either is
// null when Mediabunny does not know it.
export interface TrackCodec {
  codec: MediaCodec | null
  parameters: string | null
}

// The first track this browser cannot play. A codec outside D24's lists counts
// as one it cannot play, because it has no stored type.
export interface CannotPlay {
  track: SourceTrack
  codec: MediaCodec | null
}

// What the container says, before it becomes SourceDetails.
export interface SourceFacts {
  audioTracks: number
  videoTracks: number
  // The earliest first timestamp across the tracks.
  firstTimestamp: number
  // The latest end time across the tracks.
  endTimestamp: number
  tags: MetadataTags
  // The primary tracks' codecs: the tracks a song is made from. Null when
  // there is no such track.
  videoCodec: TrackCodec | null
  audioCodec: TrackCodec | null
}

// The raw tag that holds the composer in each container: MP4, ID3v2 (MP3) and
// Matroska (WebM). Mediabunny has no composer field of its own.
const COMPOSER_KEYS = ['©wrt', 'TCOM', 'COMPOSER']

// Whether this browser can play a stored type: the Player's own check.
const defaultCanPlay = (type: string) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type)

// The caller must have initialised the core first, for its stored types.
export async function readSource(file: Blob, canPlay = defaultCanPlay): Promise<SourceDetails> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const [audio, video] = await Promise.all([input.getAudioTracks(), input.getVideoTracks()])
    // A source without audio is refused before anything else is read.
    if (audio.length === 0) throw new SourceError('no-audio')
    const [firstTimestamp, endTimestamp, tags, videoCodec, audioCodec] = await Promise.all([
      input.getFirstTimestamp(),
      input.computeDuration(),
      input.getMetadataTags(),
      input.getPrimaryVideoTrack().then(trackCodec),
      input.getPrimaryAudioTrack().then(trackCodec),
    ])
    return sourceDetailsFrom(
      {
        audioTracks: audio.length,
        videoTracks: video.length,
        firstTimestamp,
        endTimestamp,
        tags,
        videoCodec,
        audioCodec,
      },
      canPlay,
    )
  } catch (error) {
    // The error's own text is never shown, and it may hold parts of the file.
    if (error instanceof SourceError) throw error
    throw new SourceError('unreadable')
  } finally {
    input.dispose()
  }
}

async function trackCodec(track: InputTrack | null): Promise<TrackCodec | null> {
  if (track === null) return null
  const [codec, parameters] = await Promise.all([track.getCodec(), track.getCodecParameterString()])
  return { codec, parameters }
}

export function sourceDetailsFrom(facts: SourceFacts, canPlay: (type: string) => boolean): SourceDetails {
  if (facts.audioTracks === 0) throw new SourceError('no-audio')
  // Encoder priming can give a tiny negative first timestamp. That is not a
  // late start, so it does not shift the times.
  const startOffset = Math.max(0, facts.firstTimestamp)
  const details: SourceDetails = {
    duration: facts.endTimestamp - startOffset,
    startOffset,
    hasVideo: facts.videoTracks > 0,
  }
  const title = tag(facts.tags.title)
  const artist = tag(facts.tags.artist)
  const composer = COMPOSER_KEYS.map((key) => tag(facts.tags.raw?.[key])).find((value) => value !== undefined)
  if (title !== undefined) details.title = title
  if (artist !== undefined) details.artist = artist
  if (composer !== undefined) details.composer = composer
  const audioType = facts.audioCodec === null ? undefined : typeOf(facts.audioCodec)
  if (audioType !== undefined) details.audioType = audioType
  const videoType = facts.videoCodec === null ? undefined : typeOf(facts.videoCodec)
  if (videoType !== undefined) details.videoType = videoType
  // The video is checked first, so it is named when both tracks fail, as in the Player.
  const tracks: [SourceTrack, TrackCodec | null][] = [
    ['video', facts.videoCodec],
    ['audio', facts.audioCodec],
  ]
  for (const [track, found] of tracks) {
    if (found === null || plays(found, canPlay)) continue
    details.cannotPlay = { track, codec: found.codec }
    break
  }
  return details
}

// Whether the core gives the track a stored type, and this browser can play it.
function plays(found: TrackCodec, canPlay: (type: string) => boolean): boolean {
  const type = typeOf(found)
  return type !== undefined && canPlay(type)
}

// The stored type the core gives a track, if any.
function typeOf({ codec, parameters }: TrackCodec): string | undefined {
  return codec === null ? undefined : storedType(codec, parameters ?? '')
}

// A tag's text exactly as stored. Anything other than non-empty text is absent.
function tag(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
