import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal, WritableSignal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatCheckbox } from '@angular/material/checkbox'
import { MatProgressBar } from '@angular/material/progress-bar'
import { MatRadioButton, MatRadioGroup } from '@angular/material/radio'
import { ActivatedRoute } from '@angular/router'
import { TestAligner } from '../../alignment/aligner-session'
import { Device, readDevice } from '../../measurement/device'
import { backendsFor, Candidate, candidateFiles, candidatesFor, separatorFiles } from '../../measurement/candidates'
import { StageMemory } from '../../measurement/memory'
import {
  MeasurementReply,
  MeasurementRequest,
  MeasurementStage,
  RunProblem,
} from '../../measurement/measurement-messages'
import { ModelCheckFailed } from '../../models/model-download'
import { Backend } from '../../separation/backend'
import { SourceProblem } from '../../source-error'
import { runAlignerCheck } from '../aligner-check'
import { MeasurementRun, runMeasurement } from '../measurement-run'
import { messages } from '../messages'
import { Models } from '../models'
import { Player } from '../player.component'
import { runSeparatorCheck } from '../separator-check'
import { makeMeasuredSongInWorker, Packaging } from '../source-check/original-track-worker'
import { resultsText, Row } from './results-text'

// The test entry the page downloads: the 56-byte two-block test vector.
const TEST_MODEL = 'test-two-block'

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'passed' }
  | { status: 'check-failed' }
  | { status: 'download-failed' }

type SeparatorState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ran'; backend: Backend; xOut: number[]; xtOut: number[] }
  | { status: 'failed' }

type AlignerState =
  | { status: 'idle' }
  | { status: 'preparing' }
  | { status: 'running'; backend: Backend; done: number; total: number }
  | { status: 'aligned'; backend: Backend; done: number; total: number; syllables: number }
  | { status: 'failed'; problem: 'timing' | 'other' }

type MeasurementState =
  | { status: 'idle' }
  | { status: 'downloading' }
  | { status: 'download-failed'; id: string; checkFailed: boolean }
  | { status: 'running'; stage: MeasurementStage; backend?: Backend; candidate?: Candidate }
  | { status: 'done' }
  | { status: 'failed'; problem: SourceProblem }

// What the separation measured on one backend, once for every candidate on it.
type Separation = Omit<Extract<MeasurementReply, { type: 'separated' }>, 'type' | 'backend'>

// What a candidate gave on one backend: its figures, or why it failed and
// whether it ran at all.
type Outcome =
  | ({ status: 'measured' } & Omit<Extract<MeasurementReply, { type: 'measured' }>, 'type' | 'candidate' | 'backend'>)
  | { status: 'failed'; ran: boolean; problem: RunProblem }

const seconds = (ms: number) => messages.seconds((ms / 1000).toFixed(2))
const bytesOr = (bytes?: number) => (bytes === undefined ? messages.notReported : messages.bytes(bytes))

// A measured candidate's figures on one backend. The extract figures repeat in
// every result, and the backend's separation figures in each of its
// candidates' results. Each ID starts with the backend and the candidate, so
// it is unique.
function rowsFor(
  candidate: Candidate,
  backend: Backend,
  outcome: Outcome,
  extract: { ms: number; memory: StageMemory } | undefined,
  separation: Separation | undefined,
): Row[] {
  if (outcome.status !== 'measured' || extract === undefined || separation === undefined) return []
  const row = (key: string, label: string, value: string): Row => ({
    id: `${backend}-${candidate}-${key}`,
    label,
    value,
  })
  return [
    row('backend', messages.measurementBackend, messages.backendNames[backend]),
    row('extract', messages.measurementExtract, seconds(extract.ms)),
    row('separate', messages.measurementSeparate, seconds(separation.separateMs)),
    row('align', messages.measurementAlign, seconds(outcome.alignMs)),
    row('load', messages.measurementModelLoad, seconds(outcome.loadMs)),
    row('sum-check', messages.measurementSumCheck, messages.decibels(separation.sumCheckDb.toFixed(1))),
    row('extract-wasm', messages.measurementExtractWasmMemory, bytesOr(extract.memory.wasmBytes)),
    row('extract-heap', messages.measurementExtractHeap, bytesOr(extract.memory.heapBytes)),
    row('separate-wasm', messages.measurementSeparateWasmMemory, bytesOr(separation.memory.wasmBytes)),
    row('separate-heap', messages.measurementSeparateHeap, bytesOr(separation.memory.heapBytes)),
    row('align-wasm', messages.measurementAlignWasmMemory, bytesOr(outcome.memory.wasmBytes)),
    row('align-heap', messages.measurementAlignHeap, bytesOr(outcome.memory.heapBytes)),
  ]
}

// The rows of the Device section. Each ID is unique on the page.
function deviceRows(device: Device): Row[] {
  const text = (value?: string) => value ?? messages.notReported
  return [
    { id: 'device-browser', label: messages.deviceBrowser, value: text(device.browser) },
    { id: 'device-os', label: messages.deviceOs, value: text(device.os) },
    { id: 'device-gpu-vendor', label: messages.deviceGpuVendor, value: text(device.vendor) },
    { id: 'device-gpu-architecture', label: messages.deviceGpuArchitecture, value: text(device.architecture) },
    { id: 'device-gpu-description', label: messages.deviceGpuDescription, value: text(device.description) },
    {
      id: 'device-webgpu',
      label: messages.deviceWebGpu,
      value: device.webgpu ? messages.webGpuAvailable : messages.webGpuNotAvailable,
    },
  ]
}

// Why a run failed, as the page says it.
function reasonFor(problem: RunProblem): string {
  if (problem.kind === 'sum-check') return messages.sumCheckFailed[problem.rule](problem.measuredDb.toFixed(1))
  return messages.runProblems[problem.kind]
}

// The model check page (docs/ui-conventions.md#check-pages). It downloads,
// checks and keeps a pinned test file, until the real models are added. It
// also runs the test separator with ONNX Runtime Web in a Web Worker, and
// times the syllables of a picked lyrics file on test audio with a test
// aligner in another, stage 4 of processing. Opened by its URL,
// #/model-check. With ?backend=wasm, the separator runs on WebAssembly even
// when the browser has a GPU, and Force WebAssembly starts ticked for the
// aligner. Its measurement section measures each candidate aligner
// (docs/reference/models.md#measurement-method), in a Web Worker. It needs a
// source and the lyrics. It decodes a picked source
// once. Then, on WebGPU and then on one-thread WebAssembly, it separates the
// source and times the picked lyrics on the vocals with each candidate, never
// switching backend. Each candidate on each backend gets its own result: its
// figures, or why it failed. With ?model=test it measures the test aligners
// after the test separator, and ?backend=wasm measures only WebAssembly. A Device section names the browser,
// the OS and the GPU, and says whether WebGPU is available. Each result also
// shows the highest WebAssembly memory and JavaScript heap seen in each stage,
// or "not reported" for a figure the browser does not give. After each
// separation, players play its vocals and karaoke track from memory, so the
// owner can listen for leftover lead vocals. A later separation replaces the
// earlier one's, and a new measurement or leaving the page frees them. The Copy
// results button puts the Device section and every result on the clipboard as
// plain text, and a line beside it says whether the browser allowed it. Each
// measured result's Play with this timing button makes a song in another Web
// Worker from the source, the lyrics, the karaoke track of the result's
// backend and the result's timing, and a Player plays it (D26). The song stays
// in memory: it is not kept in the library, downloaded or sent anywhere.
// Another result's song replaces it, and a new measurement or leaving the page
// frees it.
@Component({
  selector: 'lyre-model-check',
  imports: [MatButton, MatCheckbox, MatProgressBar, MatRadioButton, MatRadioGroup, Player],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    @let separator = separatorState();
    @let aligning = alignerState();
    @let measuring = measurement();
    @let busy =
      current.status === 'running' ||
      separator.status === 'running' ||
      aligning.status === 'preparing' ||
      aligning.status === 'running' ||
      measuring.status === 'downloading' ||
      measuring.status === 'running' ||
      songState() === 'making';
    <h2>{{ messages.modelCheckTitle }}</h2>
    <p>{{ messages.modelCheckAbout }}</p>
    <button matButton="filled" type="button" [disabled]="busy" (click)="load()">
      {{ messages.downloadTestModel }}
    </button>
    <mat-progress-bar
      mode="determinate"
      [value]="percent()"
      [attr.aria-label]="messages.modelProgress"
      [attr.aria-valuetext]="bytes()"
    />
    <!-- Outside the status line, so a screen reader does not announce each update. -->
    @if (bytes(); as bytes) {
      <p>{{ bytes }}</p>
    }
    <p role="status">
      @switch (current.status) {
        @case ('passed') {
          {{ messages.modelPassed(testModel) }}
        }
        @case ('check-failed') {
          {{ messages.modelCheckFailed(testModel) }}
        }
        @case ('download-failed') {
          {{ messages.modelDownloadFailed(testModel) }}
        }
      }
    </p>
    <p>{{ messages.separatorCheckAbout }}</p>
    <button matButton="filled" type="button" [disabled]="busy" (click)="runSeparator()">
      {{ messages.runTestSeparator }}
    </button>
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">
      @switch (separator.status) {
        @case ('running') {
          {{ messages.separatorRunning }}
        }
        @case ('ran') {
          {{ messages.separatorRan(messages.backendNames[separator.backend], separator.xOut, separator.xtOut) }}
        }
        @case ('failed') {
          {{ messages.separatorFailed }}
        }
      }
    </p>
    <p>{{ messages.alignerCheckAbout }}</p>
    <mat-radio-group
      [attr.aria-label]="messages.testAligner"
      [value]="aligner()"
      [disabled]="busy"
      (change)="aligner.set($event.value)"
    >
      @for (name of aligners; track name) {
        <mat-radio-button [value]="name">{{ messages.alignerNames[name] }}</mat-radio-button>
      }
    </mat-radio-group>
    <mat-checkbox [checked]="forceWasm()" [disabled]="busy" (change)="forceWasm.set($event.checked)">
      {{ messages.forceWebAssembly }}
    </mat-checkbox>
    <button matButton="filled" type="button" [disabled]="busy" (click)="lyricsInput.click()">
      {{ messages.alignTestAudio }}
    </button>
    <input #lyricsInput type="file" accept="text/plain,.txt" hidden (change)="align(lyricsInput)" />
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">
      @switch (aligning.status) {
        @case ('preparing') {
          {{ messages.alignerPreparing }}
        }
        @case ('running') {
          {{ messages.alignmentRunning(messages.backendNames[aligning.backend], aligning.done, aligning.total) }}
        }
        @case ('aligned') {
          {{ messages.alignmentDone(messages.backendNames[aligning.backend], aligning.done, aligning.total) }}
        }
        @case ('failed') {
          {{ aligning.problem === 'timing' ? messages.timingRefused : messages.alignerFailed }}
        }
      }
    </p>
    @if (aligning.status === 'aligned') {
      <p>{{ messages.syllablesTimed(aligning.syllables) }}</p>
    }
    <p>{{ messages.measurementAbout }}</p>
    @if (deviceRows(); as deviceRows) {
      <section aria-labelledby="device-name">
        <h3 id="device-name">{{ messages.deviceTitle }}</h3>
        <dl>
          @for (row of deviceRows; track row.id) {
            <dt [id]="row.id">{{ row.label }}</dt>
            <dd [attr.aria-labelledby]="row.id">{{ row.value }}</dd>
          }
        </dl>
      </section>
    }
    <button matButton="filled" type="button" [disabled]="busy" (click)="sourceInput.click()">
      {{ messages.chooseSource }}
    </button>
    <input
      #sourceInput
      type="file"
      accept="video/mp4,video/webm,audio/mpeg,.mp4,.webm,.mp3"
      hidden
      (change)="pick(sourceInput, source)"
    />
    <button matButton="filled" type="button" [disabled]="busy" (click)="measuredLyricsInput.click()">
      {{ messages.chooseLyrics }}
    </button>
    <input
      #measuredLyricsInput
      type="file"
      accept="text/plain,.txt"
      hidden
      (change)="pick(measuredLyricsInput, lyrics)"
    />
    <button matButton="filled" type="button" [disabled]="busy || !source() || !lyrics()" (click)="measure()">
      {{ messages.measureAligners }}
    </button>
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">{{ measurementLine() }}</p>
    @if (tracks(); as tracks) {
      <section aria-labelledby="tracks-name">
        <h3 id="tracks-name">{{ messages.measurementTracks(messages.backendNames[tracks.backend]) }}</h3>
        <p>{{ messages.measurementTracksAbout }}</p>
        <audio
          controls
          preload="metadata"
          [src]="tracks.vocalsUrl"
          [attr.aria-label]="messages.measurementVocals"
        ></audio>
        <audio
          controls
          preload="metadata"
          [src]="tracks.karaokeUrl"
          [attr.aria-label]="messages.measurementKaraoke"
        ></audio>
      </section>
    }
    @for (result of results(); track result.id) {
      <section [attr.aria-labelledby]="result.id + '-name'">
        <h3 [id]="result.id + '-name'">{{ result.name }}</h3>
        @if (result.failure; as failure) {
          @if (!failure.ran) {
            <p>{{ messages.notRun }}</p>
          }
          <p>{{ failure.reason }}</p>
        } @else {
          <!-- Each value is alone in its row, so the row's text is exactly the value. -->
          <dl>
            @for (row of result.rows; track row.id) {
              <dt [id]="row.id">{{ row.label }}</dt>
              <dd [attr.aria-labelledby]="row.id">{{ row.value }}</dd>
            }
          </dl>
          <button
            matButton="tonal"
            type="button"
            [disabled]="busy"
            [attr.aria-label]="messages.playWithTimingOf(result.name)"
            (click)="play(result)"
          >
            {{ messages.playWithTiming }}
          </button>
        }
      </section>
    }
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">
      @switch (songState()) {
        @case ('making') {
          {{ messages.measuredSongMaking }}
        }
        @case ('failed') {
          {{ messages.measuredSongFailed }}
        }
      }
    </p>
    @if (measuredSong(); as measuredSong) {
      <section aria-labelledby="measured-song-name">
        <h3 id="measured-song-name">{{ messages.measuredSongTitle(measuredSong.name) }}</h3>
        <p>{{ messages.measuredSongAbout }}</p>
        <lyre-player [song]="measuredSong.song" />
      </section>
    }
    <button matButton="filled" type="button" [disabled]="busy || !deviceRows()" (click)="copy()">
      {{ messages.copyResults }}
    </button>
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">
      @switch (copyState()) {
        @case ('copied') {
          {{ messages.resultsCopied }}
        }
        @case ('refused') {
          {{ messages.resultsNotCopied }}
        }
      }
    </p>
    @if (models.mayBeCleared()) {
      <p>{{ messages.modelsMayBeCleared }}</p>
    }
  `,
})
export class ModelCheckPage {
  protected readonly messages = messages
  protected readonly testModel = TEST_MODEL
  protected readonly models = inject(Models)
  protected readonly state = signal<State>({ status: 'idle' })
  protected readonly separatorState = signal<SeparatorState>({ status: 'idle' })
  protected readonly alignerState = signal<AlignerState>({ status: 'idle' })
  protected readonly aligners: readonly TestAligner[] = ['omnilingual', 'lyric-alignment']
  protected readonly aligner = signal<TestAligner>('omnilingual')
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap
  private readonly forced: Backend | undefined = this.query.get('backend') === 'wasm' ? 'wasm' : undefined
  protected readonly forceWasm = signal(this.forced === 'wasm')
  private readonly test = this.query.get('model') === 'test'
  // The files picked for a measurement.
  protected readonly source = signal<File | undefined>(undefined)
  protected readonly lyrics = signal<File | undefined>(undefined)
  protected readonly measurement = signal<MeasurementState>({ status: 'idle' })
  // The device the page runs on, once the browser has told it.
  protected readonly device = signal<Device | undefined>(undefined)
  protected readonly extract = signal<{ ms: number; memory: StageMemory } | undefined>(undefined)
  // The separation's figures on each backend that separated.
  protected readonly separations = signal<Partial<Record<Backend, Separation>>>({})
  // The object URLs of the latest separation's tracks, played from memory.
  protected readonly tracks = signal<{ backend: Backend; vocalsUrl: string; karaokeUrl: string } | undefined>(undefined)
  // The 16-bit WAV file of each backend's karaoke track, which a measured song
  // is made from, until the next measurement.
  private readonly karaokeWavs = signal<Partial<Record<Backend, Blob>>>({})
  // The song made with a result's timing, named after the result, and whether
  // a song is being made or could not be made.
  protected readonly measuredSong = signal<{ name: string; song: Blob } | undefined>(undefined)
  protected readonly songState = signal<'idle' | 'making' | 'failed'>('idle')
  // Each candidate that has finished on a backend, in the order it ran.
  protected readonly outcomes = signal<{ candidate: Candidate; backend: Backend; outcome: Outcome }[]>([])
  protected readonly deviceRows = computed(() => {
    const device = this.device()
    return device && deviceRows(device)
  })
  // Whether the last copy of the results worked.
  protected readonly copyState = signal<'idle' | 'copied' | 'refused'>('idle')
  protected readonly measurementLine = computed(() => this.lineFor(this.measurement()))
  protected readonly results = computed(() =>
    this.outcomes().map(({ candidate, backend, outcome }) => ({
      id: `${backend}-${candidate}`,
      backend,
      timesMs: outcome.status === 'measured' ? outcome.timesMs : undefined,
      name: messages.candidateOnBackend(messages.candidateNames[candidate], messages.backendNames[backend]),
      rows: rowsFor(candidate, backend, outcome, this.extract(), this.separations()[backend]),
      failure: outcome.status === 'failed' ? { ran: outcome.ran, reason: reasonFor(outcome.problem) } : undefined,
    })),
  )
  // Counts the measurements started, so only the latest one shows.
  private attempts = 0
  // The measurement running, if any.
  private run: MeasurementRun | undefined
  // The source and the lyrics of the latest measurement, which a measured song
  // is made from, even when other files are picked afterwards.
  private measured: { source: File; lyrics: Blob } | undefined
  // Counts the songs asked for, so only the latest one shows.
  private songAttempts = 0
  // The measured song being made, if any.
  private making: Packaging | undefined
  // The bytes downloaded so far, which stay shown after the download ends.
  protected readonly bytes = computed(() => {
    const progress = this.models.progress()
    return progress && messages.modelDownloading(progress.id, progress.loadedBytes, progress.totalBytes)
  })
  protected readonly percent = computed(() => {
    const progress = this.models.progress()
    if (!progress) return this.state().status === 'passed' ? 100 : 0
    return progress.totalBytes === 0 ? 100 : (progress.loadedBytes / progress.totalBytes) * 100
  })

  constructor() {
    void readDevice().then((device) => this.device.set(device))
    inject(DestroyRef).onDestroy(() => {
      // A run's later replies then show nowhere.
      this.attempts++
      this.run?.stop()
      this.revokeTracks()
      this.clearMeasuredSong()
    })
  }

  protected async load(): Promise<void> {
    this.state.set({ status: 'running' })
    try {
      // The file is not used yet: the page only shows that it passed.
      await this.models.load(TEST_MODEL)
      this.state.set({ status: 'passed' })
    } catch (error) {
      // Any other failure, such as storage the browser blocks, also keeps nothing.
      this.state.set({ status: error instanceof ModelCheckFailed ? 'check-failed' : 'download-failed' })
    }
  }

  protected async runSeparator(): Promise<void> {
    this.separatorState.set({ status: 'running' })
    try {
      const reply = await runSeparatorCheck(this.models, this.forced)
      this.separatorState.set(
        reply.type === 'ran'
          ? { status: 'ran', backend: reply.backend, xOut: reply.xOut, xtOut: reply.xtOut }
          : { status: 'failed' },
      )
    } catch {
      // A file that failed its check or could not be downloaded is not run.
      this.separatorState.set({ status: 'failed' })
    }
  }

  protected async align(input: HTMLInputElement): Promise<void> {
    const lyrics = input.files?.[0]
    // Clears the choice, so picking the same file again aligns it again.
    input.value = ''
    if (!lyrics) return
    this.alignerState.set({ status: 'preparing' })
    const reply = await runAlignerCheck(
      this.models,
      this.aligner(),
      lyrics,
      this.forceWasm() ? 'wasm' : undefined,
      ({ backend, done, total }) => this.alignerState.set({ status: 'running', backend, done, total }),
    )
    if (reply.type === 'failed') {
      this.alignerState.set({ status: 'failed', problem: reply.problem })
      return
    }
    if (reply.type !== 'aligned') return
    const current = this.alignerState()
    // The worker answers in order, so the last progress reply already counted every window.
    const { done, total } = current.status === 'running' ? current : { done: 0, total: 0 }
    this.alignerState.set({ status: 'aligned', backend: reply.backend, done, total, syllables: reply.syllables })
  }

  protected pick(input: HTMLInputElement, picked: WritableSignal<File | undefined>): void {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again still counts.
    input.value = ''
    if (file) picked.set(file)
  }

  protected async measure(): Promise<void> {
    const source = this.source()
    const lyricsFile = this.lyrics()
    if (!source || !lyricsFile) return
    this.run?.stop()
    this.run = undefined
    const attempt = ++this.attempts
    const current = () => attempt === this.attempts
    this.measurement.set({ status: 'downloading' })
    this.extract.set(undefined)
    this.separations.set({})
    this.outcomes.set([])
    this.copyState.set('idle')
    this.revokeTracks()
    this.clearMeasuredSong()
    this.measured = { source, lyrics: lyricsFile }
    const loaded = await this.loadFiles()
    if (!current()) return
    if ('status' in loaded) {
      this.measurement.set(loaded)
      return
    }
    const request: MeasurementRequest = {
      type: 'run',
      source,
      lyrics: lyricsFile,
      ...loaded,
      baseUri: document.baseURI,
      backends: backendsFor(this.forced),
    }
    this.run = runMeasurement(request, (reply) => {
      if (current()) this.show(reply)
    })
    await this.run.done
    if (current()) this.run = undefined
  }

  // Makes a song from the measurement's source and lyrics, the karaoke track
  // of the result's backend and the result's timing, then plays it in place of
  // the song before.
  protected async play(result: { name: string; backend: Backend; timesMs?: Uint32Array }): Promise<void> {
    const karaokeWav = this.karaokeWavs()[result.backend]
    if (!this.measured || !result.timesMs || !karaokeWav) return
    this.making?.stop()
    const attempt = ++this.songAttempts
    this.songState.set('making')
    const making = makeMeasuredSongInWorker({
      baseUri: document.baseURI,
      file: this.measured.source,
      lyrics: this.measured.lyrics,
      timesMs: result.timesMs,
      karaokeWav,
      songId: crypto.getRandomValues(new Uint8Array(16)),
    })
    this.making = making
    const reply = await making.reply
    // A song stopped or asked for again shows nowhere.
    if (attempt !== this.songAttempts) return
    this.making = undefined
    if (reply.type === 'song-done') {
      this.measuredSong.set({ name: result.name, song: new Blob([reply.bytes as Uint8Array<ArrayBuffer>]) })
      this.songState.set('idle')
    } else {
      this.songState.set('failed')
    }
  }

  protected async copy(): Promise<void> {
    // Outside a secure context the browser has no clipboard API, which counts as a refusal.
    if (!navigator.clipboard?.writeText) {
      this.copyState.set('refused')
      return
    }
    try {
      await navigator.clipboard.writeText(resultsText(this.deviceRows(), this.results()))
      this.copyState.set('copied')
    } catch {
      this.copyState.set('refused')
    }
  }

  // Loads the separator's files and each candidate's, downloading the ones
  // missing. Any file that fails stops the run, so no comparison is incomplete.
  private async loadFiles(): Promise<
    Pick<MeasurementRequest, 'separator' | 'candidates'> | Extract<MeasurementState, { status: 'download-failed' }>
  > {
    const loaded = new Map<string, Blob>()
    let id = ''
    const load = async (next: string) => {
      id = next
      const blob = loaded.get(next) ?? (await this.models.load(next))
      loaded.set(next, blob)
      return blob
    }
    try {
      const separator = separatorFiles(this.test)
      const graph = await load(separator.graph)
      const weights = await load(separator.weights)
      const candidates: MeasurementRequest['candidates'] = []
      for (const candidate of candidatesFor(this.test)) {
        const files = candidateFiles[candidate]
        candidates.push({
          candidate,
          kind: files.kind,
          graph: await load(files.graph),
          vocabulary: await load(files.vocabulary),
        })
      }
      return { separator: { graph, weights }, candidates }
    } catch (error) {
      // Any other failure, such as storage the browser blocks, also keeps nothing.
      return { status: 'download-failed', id, checkFailed: error instanceof ModelCheckFailed }
    }
  }

  private show(reply: MeasurementReply): void {
    switch (reply.type) {
      case 'stage':
        this.measurement.set({
          status: 'running',
          stage: reply.stage,
          backend: reply.backend,
          candidate: reply.candidate,
        })
        break
      case 'extracted':
        this.extract.set({ ms: reply.extractMs, memory: reply.memory })
        break
      case 'separated': {
        const { backend, separateMs, sumCheckDb, memory } = reply
        this.separations.update((separations) => ({
          ...separations,
          [backend]: { separateMs, sumCheckDb, memory },
        }))
        break
      }
      case 'tracks': {
        this.revokeTracks()
        const wav = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes], { type: 'audio/wav' })
        // The same karaoke file plays here and makes the backend's measured songs.
        const karaoke = wav(reply.karaoke)
        this.karaokeWavs.update((wavs) => ({ ...wavs, [reply.backend]: karaoke }))
        this.tracks.set({
          backend: reply.backend,
          vocalsUrl: URL.createObjectURL(wav(reply.vocals)),
          karaokeUrl: URL.createObjectURL(karaoke),
        })
        break
      }
      case 'measured': {
        const { candidate, backend, loadMs, alignMs, memory, timesMs } = reply
        const outcome: Outcome = { status: 'measured', loadMs, alignMs, memory, timesMs }
        this.outcomes.update((outcomes) => [...outcomes, { candidate, backend, outcome }])
        break
      }
      case 'candidate-failed': {
        const { candidate, backend, ran, problem } = reply
        const outcome: Outcome = { status: 'failed', ran, problem }
        this.outcomes.update((outcomes) => [...outcomes, { candidate, backend, outcome }])
        break
      }
      case 'failed':
        this.measurement.set({ status: 'failed', problem: reply.problem })
        break
      case 'done':
        this.measurement.set({ status: 'done' })
        break
    }
  }

  // Stops any song being made, and frees the measured song, the karaoke
  // tracks it is made from and the files of the measurement.
  private clearMeasuredSong(): void {
    this.songAttempts++
    this.making?.stop()
    this.making = undefined
    this.measuredSong.set(undefined)
    this.songState.set('idle')
    this.karaokeWavs.set({})
    this.measured = undefined
  }

  // Frees the tracks shown, if any.
  private revokeTracks(): void {
    const tracks = this.tracks()
    if (!tracks) return
    URL.revokeObjectURL(tracks.vocalsUrl)
    URL.revokeObjectURL(tracks.karaokeUrl)
    this.tracks.set(undefined)
  }

  private lineFor(state: MeasurementState): string {
    switch (state.status) {
      case 'idle':
        return ''
      case 'downloading':
        return messages.measurementDownloading
      case 'download-failed':
        return state.checkFailed ? messages.modelCheckFailed(state.id) : messages.modelDownloadFailed(state.id)
      case 'running': {
        if (state.stage === 'extract') return messages.measurementExtracting
        const backend = state.backend ? messages.backendNames[state.backend] : ''
        if (state.stage === 'separate') return messages.measurementSeparating(backend)
        return messages.measurementAligning(state.candidate ? messages.candidateNames[state.candidate] : '', backend)
      }
      case 'done':
        return messages.measurementDone
      case 'failed':
        return state.problem === 'no-audio' ? messages.sourceNoAudio : messages.sourceUnreadable
    }
  }
}
