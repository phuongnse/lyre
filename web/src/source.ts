import { BlobSource, Input, MP3, MP4, MetadataTags, WEBM } from 'mediabunny'

// Reads a source's details: stage 1 of processing
// (docs/domain/knowledge.md#processing). It only reads the container, through
// Mediabunny, and decodes nothing. The source is never changed or sent anywhere.

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
}

// Why a source was refused. Mediabunny's own messages are not meant for users.
export type SourceProblem = 'no-audio' | 'unreadable'

export class SourceError extends Error {
  constructor(readonly problem: SourceProblem) {
    super(problem)
    this.name = 'SourceError'
  }
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
}

// The raw tag that holds the composer in each container: MP4, ID3v2 (MP3) and
// Matroska (WebM). Mediabunny has no composer field of its own.
const COMPOSER_KEYS = ['©wrt', 'TCOM', 'COMPOSER']

export async function readSource(file: Blob): Promise<SourceDetails> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const [audio, video] = await Promise.all([input.getAudioTracks(), input.getVideoTracks()])
    // A source without audio is refused before anything else is read.
    if (audio.length === 0) throw new SourceError('no-audio')
    const [firstTimestamp, endTimestamp, tags] = await Promise.all([
      input.getFirstTimestamp(),
      input.computeDuration(),
      input.getMetadataTags(),
    ])
    return sourceDetailsFrom({
      audioTracks: audio.length,
      videoTracks: video.length,
      firstTimestamp,
      endTimestamp,
      tags,
    })
  } catch (error) {
    // The error's own text is never shown, and it may hold parts of the file.
    if (error instanceof SourceError) throw error
    throw new SourceError('unreadable')
  } finally {
    input.dispose()
  }
}

export function sourceDetailsFrom(facts: SourceFacts): SourceDetails {
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
  return details
}

// A tag's text exactly as stored. Anything other than non-empty text is absent.
function tag(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
