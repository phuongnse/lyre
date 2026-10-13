import { ChangeDetectionStrategy, Component, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { loadCore } from '../../core'
import { canEncodeKaraoke } from '../../karaoke-track'
import { SegmentTimes } from '../../original-track-messages'
import { CannotPlay, SourceDetails, SourceError, SourceProblem, readSource } from '../../source'
import { ALIGNMENT_FORMAT, AudioFormat, SEPARATION_FORMAT, decodeAudio } from '../../source-audio'
import { messages } from '../messages'
import { Packaging, makeAudioInWorker, packageInWorker } from './original-track-worker'

// What came out of decoding, measured without keeping the samples. The tone
// and the first sound are absent when the audio is silent.
interface DecodedAudio {
  sampleRate: number
  channels: number
  seconds: number
  toneHz?: number
  firstSound?: number
}

// What packaging the original track gave: only its summary reaches the page.
interface PackagedSummary {
  storedType: string
  segmentCount: number
  durationMs: number
}

// What making both audio tracks gave: only their segment times reach the page.
interface AudioTracks {
  original: SegmentTimes[]
  karaoke: SegmentTimes[]
  songDurationMs: number
}

type State =
  | { status: 'empty' }
  | { status: 'reading' }
  | {
      status: 'ready'
      file: File
      details: SourceDetails
      decoded?: DecodedAudio
      packaged?: PackagedSummary
      tracks?: AudioTracks
    }
  | { status: 'decoding'; file: File; details: SourceDetails }
  | { status: 'packaging'; file: File; details: SourceDetails }
  | { status: 'package-failed'; file: File; details: SourceDetails }
  | { status: 'making'; file: File; details: SourceDetails }
  | { status: 'make-failed'; file: File; details: SourceDetails }
  | { status: 'cannot-encode'; file: File; details: SourceDetails }
  | { status: 'failed'; problem: SourceProblem }

// A sample louder than this counts as sound.
const LOUD = 0.01

// The source check page (docs/ui-conventions.md#check-pages). It reads a
// picked source's details, stage 1 of processing, and can decode its audio at
// a stage's rate, stage 2, or package it into the original track in a Web
// Worker, stage 8, until the real song-making page exists. With a second
// picked file standing in for the karaoke track, it can also make both audio
// tracks, cut at the same times, in the worker. A source this
// browser cannot play shows the reason next to its details, and can still be
// decoded and packaged, because this is a test page. Opened by its URL,
// #/source-check.
// The route is lazy, so Mediabunny stays out of the main app's initial load.
@Component({
  selector: 'lyre-source-check',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <h2>{{ messages.sourceCheckTitle }}</h2>
    <p>{{ messages.sourceCheckAbout }}</p>
    <button matButton="filled" type="button" [disabled]="current.status === 'reading'" (click)="fileInput.click()">
      {{ messages.chooseSource }}
    </button>
    <input
      #fileInput
      type="file"
      accept="video/mp4,video/webm,audio/mpeg,.mp4,.webm,.mp3"
      hidden
      (change)="read(fileInput)"
    />
    @switch (current.status) {
      @case ('reading') {
        <p role="status">{{ messages.sourceReading }}</p>
      }
      @case ('failed') {
        <p role="alert">
          {{ current.problem === 'no-audio' ? messages.sourceNoAudio : messages.sourceUnreadable }}
        </p>
      }
    }
    @if (
      current.status === 'ready' ||
      current.status === 'decoding' ||
      current.status === 'packaging' ||
      current.status === 'package-failed' ||
      current.status === 'making' ||
      current.status === 'make-failed' ||
      current.status === 'cannot-encode'
    ) {
      @let details = current.details;
      @let busy = current.status === 'decoding' || current.status === 'packaging' || current.status === 'making';
      @if (details.cannotPlay !== undefined) {
        <p role="alert">{{ cannotPlayReason(details.cannotPlay) }}</p>
      }
      <!-- Each tag is alone in its row, so the row's text is exactly the tag. -->
      <dl [attr.aria-label]="messages.sourceDetails">
        <dt id="source-duration">{{ messages.sourceDuration }}</dt>
        <dd aria-labelledby="source-duration">{{ messages.seconds(details.duration.toFixed(2)) }}</dd>
        @if (details.startOffset > 0) {
          <dt id="source-start-offset">{{ messages.sourceStartOffset }}</dt>
          <dd aria-labelledby="source-start-offset">{{ messages.seconds(details.startOffset.toFixed(2)) }}</dd>
        }
        <dt id="source-streams">{{ messages.sourceStreams }}</dt>
        <dd aria-labelledby="source-streams">{{ details.hasVideo ? messages.videoAndAudio : messages.audioOnly }}</dd>
        @if (details.title !== undefined) {
          <dt id="source-title">{{ messages.songTitle }}</dt>
          <dd aria-labelledby="source-title">{{ details.title }}</dd>
        }
        @if (details.artist !== undefined) {
          <dt id="source-artist">{{ messages.artist }}</dt>
          <dd aria-labelledby="source-artist">{{ details.artist }}</dd>
        }
        @if (details.composer !== undefined) {
          <dt id="source-composer">{{ messages.composer }}</dt>
          <dd aria-labelledby="source-composer">{{ details.composer }}</dd>
        }
      </dl>
      <button matButton="outlined" type="button" [disabled]="busy" (click)="decode(current.file, details, separation)">
        {{ messages.decodeForSeparation }}
      </button>
      <button matButton="outlined" type="button" [disabled]="busy" (click)="decode(current.file, details, alignment)">
        {{ messages.decodeForAlignment }}
      </button>
      @if (details.audioType !== undefined) {
        <button matButton="outlined" type="button" [disabled]="busy" (click)="packageTrack(current.file, details)">
          {{ messages.packageOriginal }}
        </button>
        <button matButton="outlined" type="button" [disabled]="busy" (click)="karaokeInput.click()">
          {{ messages.chooseKaraoke }}
        </button>
        <input
          #karaokeInput
          type="file"
          accept="audio/*,video/webm,video/mp4,.webm,.mp4,.mp3"
          hidden
          (change)="chooseKaraoke(karaokeInput)"
        />
        <button
          matButton="outlined"
          type="button"
          [disabled]="busy || karaokeFile() === undefined"
          (click)="makeAudio(current.file, details)"
        >
          {{ messages.makeAudioTracks }}
        </button>
      }
      @if (current.status === 'decoding') {
        <p role="status">{{ messages.sourceDecoding }}</p>
      } @else if (current.status === 'packaging') {
        <p role="status">{{ messages.sourcePackaging }}</p>
      } @else if (current.status === 'package-failed') {
        <p role="alert">{{ messages.sourcePackageFailed }}</p>
      } @else if (current.status === 'making') {
        <p role="status">{{ messages.makingAudioTracks }}</p>
      } @else if (current.status === 'make-failed') {
        <p role="alert">{{ messages.audioTracksFailed }}</p>
      } @else if (current.status === 'cannot-encode') {
        <p role="alert">{{ messages.cannotEncodeAudio }}</p>
      } @else if (current.tracks !== undefined) {
        @let tracks = current.tracks;
        <dl [attr.aria-label]="messages.audioTracks">
          <dt id="song-duration">{{ messages.songDuration }}</dt>
          <dd aria-labelledby="song-duration">{{ messages.seconds((tracks.songDurationMs / 1000).toFixed(2)) }}</dd>
        </dl>
        <ol [attr.aria-label]="messages.originalSegmentTimes">
          @for (segment of tracks.original; track $index) {
            <li>{{ messages.segmentSpan(segment.startMs, segment.endMs) }}</li>
          }
        </ol>
        <ol [attr.aria-label]="messages.karaokeSegmentTimes">
          @for (segment of tracks.karaoke; track $index) {
            <li>{{ messages.segmentSpan(segment.startMs, segment.endMs) }}</li>
          }
        </ol>
      } @else if (current.packaged !== undefined) {
        @let packaged = current.packaged;
        <dl [attr.aria-label]="messages.originalTrack">
          <dt id="original-type">{{ messages.originalStoredType }}</dt>
          <dd aria-labelledby="original-type">{{ packaged.storedType }}</dd>
          <dt id="original-segments">{{ messages.originalSegments }}</dt>
          <dd aria-labelledby="original-segments">{{ packaged.segmentCount }}</dd>
          <dt id="original-duration">{{ messages.originalDuration }}</dt>
          <dd aria-labelledby="original-duration">{{ messages.seconds((packaged.durationMs / 1000).toFixed(2)) }}</dd>
        </dl>
      } @else if (current.decoded !== undefined) {
        @let decoded = current.decoded;
        <dl [attr.aria-label]="messages.decodedAudio">
          <dt id="decoded-sample-rate">{{ messages.decodedSampleRate }}</dt>
          <dd aria-labelledby="decoded-sample-rate">{{ messages.hertz(decoded.sampleRate.toString()) }}</dd>
          <dt id="decoded-channels">{{ messages.decodedChannels }}</dt>
          <dd aria-labelledby="decoded-channels">{{ decoded.channels }}</dd>
          <dt id="decoded-length">{{ messages.decodedLength }}</dt>
          <dd aria-labelledby="decoded-length">{{ messages.seconds(decoded.seconds.toFixed(2)) }}</dd>
          @if (decoded.toneHz !== undefined) {
            <dt id="decoded-tone">{{ messages.decodedTone }}</dt>
            <dd aria-labelledby="decoded-tone">{{ messages.hertz(decoded.toneHz.toFixed(0)) }}</dd>
          }
          @if (decoded.firstSound !== undefined) {
            <dt id="decoded-first-sound">{{ messages.decodedFirstSound }}</dt>
            <dd aria-labelledby="decoded-first-sound">{{ decoded.firstSound }}</dd>
          }
        </dl>
      }
    }
  `,
})
export class SourceCheck {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'empty' })
  // The file that stands in for the karaoke track until separation exists.
  protected readonly karaokeFile = signal<File | undefined>(undefined)
  protected readonly separation = SEPARATION_FORMAT
  protected readonly alignment = ALIGNMENT_FORMAT
  // Counts the sources picked, and the decodes and packagings started, so only the latest one shows.
  private attempts = 0
  // The packaging worker running, if any.
  private packaging: Packaging | undefined

  protected async read(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again reads it again.
    input.value = ''
    if (!file) return
    this.stopPackaging()
    const attempt = ++this.attempts
    this.state.set({ status: 'reading' })
    try {
      // The core gives the stored types that the browser is asked about.
      await loadCore()
      const details = await readSource(file)
      if (attempt === this.attempts) this.state.set({ status: 'ready', file, details })
    } catch (error) {
      if (attempt !== this.attempts) return
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SourceError ? error.problem : 'unreadable'
      this.state.set({ status: 'failed', problem })
    }
  }

  protected cannotPlayReason({ track, codec }: CannotPlay): string {
    const name = codec === null ? messages.unknownCodec : messages.codecNames[codec]
    return messages.sourceCannotPlay[track](name)
  }

  protected async decode(file: File, details: SourceDetails, format: AudioFormat): Promise<void> {
    this.stopPackaging()
    const attempt = ++this.attempts
    this.state.set({ status: 'decoding', file, details })
    try {
      const measure = new AudioMeasure(format)
      for await (const planes of decodeAudio(file, format)) {
        // Leaving the loop stops decoding and closes the source.
        if (attempt !== this.attempts) return
        measure.add(planes)
      }
      if (attempt === this.attempts) this.state.set({ status: 'ready', file, details, decoded: measure.result() })
    } catch (error) {
      if (attempt !== this.attempts) return
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SourceError ? error.problem : 'unreadable'
      this.state.set({ status: 'failed', problem })
    }
  }

  // Packages the source's primary audio into the original track, in a Web
  // Worker. Only its summary comes back. Any failure shows one plain message.
  protected async packageTrack(file: File, details: SourceDetails): Promise<void> {
    if (details.audioType === undefined) return
    this.stopPackaging()
    const attempt = ++this.attempts
    this.state.set({ status: 'packaging', file, details })
    const packaging = packageInWorker(file, details.audioType)
    this.packaging = packaging
    const reply = await packaging.reply
    if (attempt !== this.attempts) return
    this.packaging = undefined
    if (reply.type === 'done') {
      const { storedType, segmentCount, durationMs } = reply
      this.state.set({ status: 'ready', file, details, packaged: { storedType, segmentCount, durationMs } })
    } else {
      this.state.set({ status: 'package-failed', file, details })
    }
  }

  protected chooseKaraoke(input: HTMLInputElement): void {
    const file = input.files?.[0]
    // Clears the choice, so the same file can be picked again.
    input.value = ''
    if (file) this.karaokeFile.set(file)
  }

  // Packages the original track, then makes the karaoke track from the picked
  // stand-in at its cut times, in a Web Worker. Only their segment times come
  // back. A browser that cannot encode Opus is told so before any work starts.
  // Any other failure shows one plain message.
  protected async makeAudio(file: File, details: SourceDetails): Promise<void> {
    const karaokeFile = this.karaokeFile()
    if (details.audioType === undefined || karaokeFile === undefined) return
    this.stopPackaging()
    const attempt = ++this.attempts
    this.state.set({ status: 'making', file, details })
    // Checked before the worker starts, so nothing is made in a browser that cannot encode.
    const canEncode = await canEncodeKaraoke()
    if (attempt !== this.attempts) return
    if (!canEncode) {
      this.state.set({ status: 'cannot-encode', file, details })
      return
    }
    const packaging = makeAudioInWorker(file, karaokeFile, details.audioType)
    this.packaging = packaging
    const reply = await packaging.reply
    if (attempt !== this.attempts) return
    this.packaging = undefined
    if (reply.type === 'audio-done') {
      const { original, karaoke, songDurationMs } = reply
      this.state.set({ status: 'ready', file, details, tracks: { original, karaoke, songDurationMs } })
    } else {
      this.state.set({ status: 'make-failed', file, details })
    }
  }

  private stopPackaging(): void {
    this.packaging?.stop()
    this.packaging = undefined
  }
}

// Measures decoded audio piece by piece. The tone counts the first channel's
// upward zero crossings between the first and the last loud frame.
class AudioMeasure {
  private frames = 0
  private firstLoud: number | undefined
  private lastLoud: number | undefined
  private previous = 0
  private crossings = 0
  private crossingsToLastLoud = 0

  constructor(private readonly format: AudioFormat) {}

  add(planes: Float32Array[]): void {
    const first = planes[0]!
    for (let i = 0; i < first.length; i++) {
      const frame = this.frames + i
      const sample = first[i]!
      if (this.firstLoud !== undefined && this.previous < 0 && sample >= 0) this.crossings++
      this.previous = sample
      if (planes.some((plane) => Math.abs(plane[i]!) > LOUD)) {
        this.firstLoud ??= frame
        this.lastLoud = frame
        this.crossingsToLastLoud = this.crossings
      }
    }
    this.frames += first.length
  }

  result(): DecodedAudio {
    const decoded: DecodedAudio = {
      sampleRate: this.format.sampleRate,
      channels: this.format.channels,
      seconds: this.frames / this.format.sampleRate,
    }
    if (this.firstLoud !== undefined && this.lastLoud !== undefined) {
      decoded.firstSound = this.firstLoud
      const span = (this.lastLoud - this.firstLoud) / this.format.sampleRate
      if (span > 0) decoded.toneHz = this.crossingsToLastLoud / span
    }
    return decoded
  }
}
