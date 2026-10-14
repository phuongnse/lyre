import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatCheckbox } from '@angular/material/checkbox'
import { MatProgressBar } from '@angular/material/progress-bar'
import { MatRadioButton, MatRadioGroup } from '@angular/material/radio'
import { ActivatedRoute } from '@angular/router'
import { TestAligner } from '../../alignment/aligner-session'
import { ModelCheckFailed } from '../../models/model-download'
import { Backend } from '../../separation/backend'
import { runAlignerCheck } from '../aligner-check'
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

// The model check page (docs/ui-conventions.md#check-pages). It downloads,
// checks and keeps a pinned test file, until the real models are added. It
// also runs the test separator with ONNX Runtime Web in a Web Worker, and
// times the syllables of a picked lyrics file on test audio with a test
// aligner in another, stage 4 of processing. Opened by its URL,
// #/model-check. With ?backend=wasm, the separator runs on WebAssembly even
// when the browser has a GPU, and Force WebAssembly starts ticked for the
// aligner.
@Component({
  selector: 'lyre-model-check',
  imports: [MatButton, MatCheckbox, MatProgressBar, MatRadioButton, MatRadioGroup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    @let separator = separatorState();
    @let aligning = alignerState();
    @let busy =
      current.status === 'running' ||
      separator.status === 'running' ||
      aligning.status === 'preparing' ||
      aligning.status === 'running';
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
  private readonly forced: Backend | undefined =
    inject(ActivatedRoute).snapshot.queryParamMap.get('backend') === 'wasm' ? 'wasm' : undefined
  protected readonly forceWasm = signal(this.forced === 'wasm')
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
}
