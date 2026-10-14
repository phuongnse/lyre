import { alignSong, AlignmentRunError, ModelRunner } from '../alignment/align-song'
import { KARAOKE_FORMAT } from '../karaoke-track'
import {
  AlignerKind,
  AlignmentFault,
  checkTiming,
  SeparationFault,
  TimingCheckFault,
  WindowFault,
} from '../lyre-wasm/lyre_wasm.js'
import { vocalsForAlignment } from '../measurement/vocals'
import { ModelCheckFailed, ModelDownloadFailed } from '../models/model-download'
import { VocalRole } from '../original-track-messages'
import { PackagedTrack, PackageError } from '../original-track'
import { Resampler } from '../resampler'
import { separate, SeparatorRunner } from '../separation/separate'
import { SongRefused, writeSong } from '../song-writer'
import { SourceDetails } from '../source'
import { AudioFormat, SEPARATION_FORMAT } from '../source-audio'
import { SourceError } from '../source-error'
import { checkVideoEnd } from '../video-track'
import { Stage, StageFailure } from './task'

// The real stages of a task, which turn a source and its lyrics into a song
// file: stages 1 to 4 and 7 to 9 of processing, in order
// (docs/domain/knowledge.md#processing). Stages 5 and 6 are planned for M8.
// The media work and the model runs come in as functions, so tests run the
// stages without WebCodecs or ONNX Runtime. The caller has loaded the core.

// What the song is made from. The aligner's files are named by the caller:
// the task never picks an aligner itself.
export interface SongTaskInput {
  source: Blob
  // The lyrics exactly as supplied. No stage copies or changes them (D5).
  lyrics: Uint8Array
  details: { title: string; artist: string; composer: string }
  vocalRole: VocalRole
  // The IDs of the pinned model files.
  separator: { graph: string; weights: string }
  aligner: { kind: 'omnilingual' | 'lyric-alignment'; model: string; vocabulary: string }
}

// The media work of stages 1, 2 and 8.
export interface SongMedia {
  readSource(file: Blob): Promise<SourceDetails>
  decode(file: Blob, format: AudioFormat): AsyncIterable<Float32Array[]>
  packageOriginal(file: Blob, type: string): Promise<PackagedTrack>
  makeKaraoke(audio: AsyncIterable<Float32Array[]>, original: PackagedTrack): Promise<PackagedTrack>
  packageVideo(file: Blob, type: string): Promise<PackagedTrack | null>
  makeThumbnail(file: Blob): Promise<Uint8Array | null>
}

// The model files and model runs of stages 3 and 4. `load` gives only a file
// that passed its check.
export interface SongModels {
  load(id: string): Promise<Blob>
  openSeparator(graph: Uint8Array, weights: Uint8Array): Promise<{ run: SeparatorRunner; release(): Promise<void> }>
  openAligner(kind: AlignerKind, graph: Uint8Array): Promise<{ run: ModelRunner; release(): Promise<void> }>
}

const kinds: Record<SongTaskInput['aligner']['kind'], AlignerKind> = {
  omnilingual: AlignerKind.Omnilingual,
  'lyric-alignment': AlignerKind.LyricAlignment,
}

// The files the stages write to the working area. The audio files are planar
// 32-bit floats: the left channel, then the right.
const AUDIO = 'audio.f32'
const KARAOKE = 'karaoke.f32'
const VOCALS = 'vocals.f32'
const TIMING = 'timing.u32'

// About 1 s of 44.1 kHz audio: how much of the karaoke track is read at a time.
const KARAOKE_PIECE_FRAMES = 44_100

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
const floatsOf = async (blob: Blob) => new Float32Array(await blob.arrayBuffer())

// Frees a core fault once it is read. Other errors hold nothing to free.
function free(error: unknown): void {
  if (
    error instanceof SeparationFault ||
    error instanceof AlignmentFault ||
    error instanceof WindowFault ||
    error instanceof TimingCheckFault
  ) {
    error.free()
  }
}

// Stops the task with `reason` when the error is `known`, and otherwise
// lets it through as unexpected. The error's own text goes nowhere.
function refused(reason: StageFailure['reason'], known: boolean, error: unknown): never {
  if (!known) throw error
  free(error)
  throw new StageFailure(reason)
}

export function songStages(input: SongTaskInput, media: SongMedia, models: SongModels): Stage[] {
  const { source, lyrics } = input
  const kind = kinds[input.aligner.kind]
  // What the stages share, besides the working area.
  let details: SourceDetails
  let audioType: string
  let audioMs = 0
  let aligner: { model: Blob; vocabulary: Blob }
  let timesMs: Uint32Array
  let tracks: { original: PackagedTrack; karaoke: PackagedTrack; video: PackagedTrack | null }
  let thumbnail: Uint8Array | null

  return [
    {
      name: 'read-source',
      async run({ progress }) {
        details = await media
          .readSource(source)
          .catch((error: unknown) => refused('source-refused', error instanceof SourceError, error))
        if (details.cannotPlay !== undefined || details.audioType === undefined) {
          throw new StageFailure('source-refused')
        }
        audioType = details.audioType
        progress(1)
      },
    },
    {
      name: 'extract-audio',
      async run({ area, progress }) {
        const expected = details.duration * SEPARATION_FORMAT.sampleRate
        const left: Float32Array[] = []
        const right: Float32Array[] = []
        let frames = 0
        try {
          for await (const [l, r] of media.decode(source, SEPARATION_FORMAT)) {
            left.push(l!)
            right.push(r!)
            frames += l!.length
            if (expected > 0) progress(Math.min(1, frames / expected))
          }
        } catch (error) {
          refused('source-refused', error instanceof SourceError, error)
        }
        await area.write(AUDIO, new Blob([...left, ...right] as Float32Array<ArrayBuffer>[]))
        audioMs = frames / (SEPARATION_FORMAT.sampleRate / 1000)
        progress(1)
      },
    },
    {
      name: 'separate',
      async run({ area, progress }) {
        // Every model file the task needs is checked before any audio is
        // separated, so a bad aligner file never wastes a long separation.
        const ids = [input.separator.graph, input.separator.weights, input.aligner.model, input.aligner.vocabulary]
        const files: Blob[] = []
        try {
          for (const id of ids) files.push(await models.load(id))
        } catch (error) {
          if (error instanceof ModelCheckFailed) throw new StageFailure('model-check-failed')
          if (error instanceof ModelDownloadFailed) throw new StageFailure('model-unavailable')
          throw error
        }
        const [graph, weights, model, vocabulary] = files as [Blob, Blob, Blob, Blob]
        aligner = { model, vocabulary }

        const audio = await floatsOf(await area.read(AUDIO))
        const frames = audio.length / 2
        const separator = await models.openSeparator(await bytesOf(graph), await bytesOf(weights))
        try {
          const separated = await separate(
            separator.run,
            audio.subarray(0, frames),
            audio.subarray(frames),
            (done, total) => progress(done / total),
          ).catch((error: unknown) => refused('separation-failed', error instanceof SeparationFault, error))
          try {
            // Each getter copies a track out of the core, so each is read once.
            await area.write(KARAOKE, separated.karaoke as Float32Array<ArrayBuffer>)
            await area.write(VOCALS, vocalsForAlignment(separated.vocals) as Float32Array<ArrayBuffer>)
          } finally {
            separated.free()
          }
        } finally {
          await separator.release().catch(() => undefined)
        }
      },
    },
    {
      name: 'align',
      async run({ area, progress }) {
        const vocals = await floatsOf(await area.read(VOCALS))
        const vocabulary = await bytesOf(aligner.vocabulary)
        const session = await models.openAligner(kind, await bytesOf(aligner.model))
        try {
          // The lyric bytes go to the core as they are (D5).
          const timing = await alignSong(vocals, lyrics, kind, vocabulary, session.run, (p) =>
            progress(p.done / p.total),
          ).catch((error: unknown) =>
            refused(
              'alignment-failed',
              error instanceof AlignmentFault ||
                error instanceof WindowFault ||
                error instanceof TimingCheckFault ||
                error instanceof AlignmentRunError,
              error,
            ),
          )
          const times = Uint32Array.from(timing.flatMap(({ startMs, endMs }) => [startMs, endMs]))
          await area.write(TIMING, times)
        } finally {
          await session.release().catch(() => undefined)
        }
      },
    },
    {
      name: 'lay-out',
      // Display lines are laid out at play time, to fit the screen (D17). So
      // this stage stores none: it checks the timing against the lyrics and
      // the length of the extracted audio, as the song file needs it.
      async run({ area, progress }) {
        const times = new Uint32Array(await (await area.read(TIMING)).arrayBuffer())
        try {
          checkTiming(times, lyrics, Math.ceil(audioMs))
        } catch (error) {
          refused('timing-refused', error instanceof TimingCheckFault, error)
        }
        timesMs = times
        progress(1)
      },
    },
    {
      name: 'package-media',
      async run({ area, progress }) {
        const steps = 4
        try {
          const original = await media.packageOriginal(source, audioType)
          progress(1 / steps)
          const karaoke = await media.makeKaraoke(karaokeAudio(await area.read(KARAOKE)), original)
          progress(2 / steps)
          const video = details.videoType === undefined ? null : await media.packageVideo(source, details.videoType)
          // The song lasts as long as its karaoke track.
          if (video !== null) checkVideoEnd(video, endOf(karaoke))
          progress(3 / steps)
          thumbnail = await media.makeThumbnail(source)
          tracks = { original, karaoke, video }
          progress(4 / steps)
        } catch (error) {
          refused('media-refused', error instanceof PackageError || error instanceof SourceError, error)
        }
      },
    },
    {
      name: 'write-song',
      async run({ progress, handOver }) {
        let song: Uint8Array
        try {
          song = writeSong({
            songId: crypto.getRandomValues(new Uint8Array(16)),
            details: { ...input.details, vocalRole: input.vocalRole },
            lyrics,
            timesMs,
            ...tracks,
            thumbnail,
          })
        } catch (error) {
          refused('song-refused', error instanceof SongRefused, error)
        }
        handOver(song)
        progress(1)
      },
    },
  ]
}

// Where a track ends on the song's timeline, in milliseconds.
function endOf({ startMs, segments }: PackagedTrack): number {
  return segments.reduce((sum, segment) => sum + segment.durationMs, startMs)
}

// Yields the separated karaoke track, planar stereo at 44.1 kHz, at the
// karaoke track's 48 kHz, about 1 s at a time, so it is never held whole.
async function* karaokeAudio(file: Blob): AsyncGenerator<Float32Array[]> {
  const frames = file.size / Float32Array.BYTES_PER_ELEMENT / 2
  const resampler = new Resampler(SEPARATION_FORMAT.sampleRate, KARAOKE_FORMAT.sampleRate, KARAOKE_FORMAT.channels)
  const plane = async (start: number, end: number) =>
    floatsOf(file.slice(start * Float32Array.BYTES_PER_ELEMENT, end * Float32Array.BYTES_PER_ELEMENT))
  for (let start = 0; start < frames; start += KARAOKE_PIECE_FRAMES) {
    const end = Math.min(frames, start + KARAOKE_PIECE_FRAMES)
    yield resampler.push([await plane(start, end), await plane(frames + start, frames + end)])
  }
  yield resampler.flush()
}
