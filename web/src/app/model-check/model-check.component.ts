import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal, WritableSignal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatCheckbox } from '@angular/material/checkbox'
import { MatProgressBar } from '@angular/material/progress-bar'
import { MatRadioButton, MatRadioGroup } from '@angular/material/radio'
import { ActivatedRoute } from '@angular/router'
import { TestAligner } from '../../alignment/aligner-session'
import { loadCore } from '../../core'
import { parseTimingFile, TimingFileErrorKind, TimingFileFault } from '../../lyre-wasm/lyre_wasm.js'
import { backendsFor, Candidate, candidateFiles, candidatesFor, separatorFiles } from '../../measurement/candidates'
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
import { runSeparatorCheck } from '../separator-check'

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
  | { status: 'reading' }
  | { status: 'files-unreadable' }
  | { status: 'timing-refused'; kind: TimingFileErrorKind; line: number }
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

// One labelled figure of a candidate's result.
interface Row {
  id: string
  label: string
  value: string
}

const seconds = (ms: number) => messages.seconds((ms / 1000).toFixed(2))
const milliseconds = (ms: number) => messages.milliseconds(ms.toFixed(0))

// A measured candidate's figures on one backend. The extract time repeats in
// every result, and the backend's separation figures in each of its
// candidates' results. Each ID starts with the backend and the candidate, so
// it is unique.
function rowsFor(
  candidate: Candidate,
  backend: Backend,
  outcome: Outcome,
  extractMs: number | undefined,
  separation: Separation | undefined,
): Row[] {
  if (outcome.status !== 'measured' || extractMs === undefined || separation === undefined) return []
  const row = (key: string, label: string, value: string): Row => ({
    id: `${backend}-${candidate}-${key}`,
    label,
    value,
  })
  return [
    row('backend', messages.measurementBackend, messages.backendNames[backend]),
    row('extract', messages.measurementExtract, seconds(extractMs)),
    row('separate', messages.measurementSeparate, seconds(separation.separateMs)),
    row('align', messages.measurementAlign, seconds(outcome.alignMs)),
    row('load', messages.measurementModelLoad, seconds(outcome.loadMs)),
    row('sum-check', messages.measurementSumCheck, messages.decibels(separation.sumCheckDb.toFixed(1))),
    row('median', messages.measurementOnsetMedian, milliseconds(outcome.medianMs)),
    row('p90', messages.measurementOnsetP90, milliseconds(outcome.p90Ms)),
    row('within-100', messages.measurementWithin100Ms, messages.percent((outcome.within100Ms * 100).toFixed(0))),
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
// aligner. Its measurement section measures each candidate aligner against a
// hand-written timing (docs/reference/models.md#measurement-method), in a Web
// Worker. It decodes a picked source once. Then, on WebGPU and then on
// one-thread WebAssembly, it separates the source and times the picked lyrics
// on the vocals with each candidate, never switching backend. Each candidate
// on each backend gets its own result: its figures, or why it failed. With
// ?model=test it measures the test aligners after the test separator, and
// ?backend=wasm measures only WebAssembly.
@Component({
  selector: 'lyre-model-check',
  imports: [MatButton, MatCheckbox, MatProgressBar, MatRadioButton, MatRadioGroup],
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
      measuring.status === 'reading' ||
      measuring.status === 'downloading' ||
      measuring.status === 'running';
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
    <button matButton="filled" type="button" [disabled]="busy" (click)="timingInput.click()">
      {{ messages.chooseTiming }}
    </button>
    <input #timingInput type="file" accept="text/plain,.txt" hidden (change)="pick(timingInput, timing)" />
    <button
      matButton="filled"
      type="button"
      [disabled]="busy || !source() || !lyrics() || !timing()"
      (click)="measure()"
    >
      {{ messages.measureAligners }}
    </button>
    <!-- Not role="status", so the download's status line stays the page's only one. -->
    <p aria-live="polite">{{ measurementLine() }}</p>
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
        }
      </section>
    }
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
  protected readonly timing = signal<File | undefined>(undefined)
  protected readonly measurement = signal<MeasurementState>({ status: 'idle' })
  protected readonly extractMs = signal<number | undefined>(undefined)
  // The separation's figures on each backend that separated.
  protected readonly separations = signal<Partial<Record<Backend, Separation>>>({})
  // Each candidate that has finished on a backend, in the order it ran.
  protected readonly outcomes = signal<{ candidate: Candidate; backend: Backend; outcome: Outcome }[]>([])
  protected readonly measurementLine = computed(() => this.lineFor(this.measurement()))
  protected readonly results = computed(() =>
    this.outcomes().map(({ candidate, backend, outcome }) => ({
      id: `${backend}-${candidate}`,
      name: messages.candidateOnBackend(messages.candidateNames[candidate], messages.backendNames[backend]),
      rows: rowsFor(candidate, backend, outcome, this.extractMs(), this.separations()[backend]),
      failure: outcome.status === 'failed' ? { ran: outcome.ran, reason: reasonFor(outcome.problem) } : undefined,
    })),
  )
  // Counts the measurements started, so only the latest one shows.
  private attempts = 0
  // The measurement running, if any.
  private run: MeasurementRun | undefined
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
    inject(DestroyRef).onDestroy(() => {
      // A run's later replies then show nowhere.
      this.attempts++
      this.run?.stop()
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
    const timingFile = this.timing()
    if (!source || !lyricsFile || !timingFile) return
    this.run?.stop()
    this.run = undefined
    const attempt = ++this.attempts
    const current = () => attempt === this.attempts
    this.measurement.set({ status: 'reading' })
    this.extractMs.set(undefined)
    this.separations.set({})
    this.outcomes.set([])
    // The timing file is read before anything is downloaded, so a bad one fails at once.
    const handStartsMs = await this.handStarts(lyricsFile, timingFile).catch((): MeasurementState => ({
      status: 'files-unreadable',
    }))
    if (!current()) return
    if (!(handStartsMs instanceof Uint32Array)) {
      this.measurement.set(handStartsMs)
      return
    }
    this.measurement.set({ status: 'downloading' })
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
      handStartsMs,
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

  // The starts of the hand-written timing, read by the core against the
  // lyrics, or the state for a refused timing file.
  private async handStarts(lyricsFile: Blob, timingFile: Blob): Promise<Uint32Array | MeasurementState> {
    // The lyric bytes go to the core as they are (D5).
    const [lyrics, timing] = await Promise.all(
      [lyricsFile, timingFile].map(async (file) => new Uint8Array(await file.arrayBuffer())),
    )
    await loadCore()
    try {
      const syllables = parseTimingFile(timing, lyrics)
      const starts = Uint32Array.from(syllables, (syllable) => syllable.startMs)
      for (const syllable of syllables) syllable.free()
      return starts
    } catch (error) {
      if (!(error instanceof TimingFileFault)) throw error
      const { kind, line } = error
      error.free()
      return { status: 'timing-refused', kind, line: line ?? 0 }
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
        this.extractMs.set(reply.extractMs)
        break
      case 'separated': {
        const { backend, separateMs, sumCheckDb } = reply
        this.separations.update((separations) => ({ ...separations, [backend]: { separateMs, sumCheckDb } }))
        break
      }
      case 'measured': {
        const { candidate, backend, loadMs, alignMs, medianMs, p90Ms, within100Ms } = reply
        const outcome: Outcome = { status: 'measured', loadMs, alignMs, medianMs, p90Ms, within100Ms }
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

  private lineFor(state: MeasurementState): string {
    switch (state.status) {
      case 'idle':
        return ''
      case 'reading':
        return messages.measurementReading
      case 'files-unreadable':
        return messages.measurementFilesUnreadable
      case 'timing-refused':
        return state.kind === TimingFileErrorKind.Lyrics
          ? messages.songLyricsInvalid
          : messages.measurementTimingFile[
              TimingFileErrorKind[state.kind] as keyof typeof messages.measurementTimingFile
            ](state.line)
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
