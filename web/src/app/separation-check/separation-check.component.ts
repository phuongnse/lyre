import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatProgressBar } from '@angular/material/progress-bar'
import { ActivatedRoute } from '@angular/router'
import { Backend } from '../../separation/backend'
import { BrokenRunRule, brokenRunValue } from '../../separation/separation-messages'
import { SourceProblem } from '../../source-error'
import { messages } from '../messages'
import { Models } from '../models'
import { SeparationRun, runSeparation } from '../separation-run'

// How far a run has come: segments done out of the total.
interface Progress {
  backend: Backend
  done: number
  total: number
}

// The lengths a finished run gave, in seconds. The tracks are not kept.
interface Lengths {
  sourceSeconds: number
  vocalsSeconds: number
  karaokeSeconds: number
}

type State =
  | { status: 'empty' }
  | { status: 'preparing' }
  | { status: 'running'; progress: Progress }
  | { status: 'separated'; progress: Progress; lengths: Lengths }
  | { status: 'broken-run'; rule: BrokenRunRule; value: number }
  | { status: 'failed'; problem: SourceProblem | 'model' }

// The separation check page (docs/ui-conventions.md#check-pages). It decodes
// a picked source and separates its audio into vocals and a karaoke track in
// a Web Worker, stage 3 of processing, until the real song-making page
// exists. Opened by its URL, #/separation-check. It runs Kim's Mel-Band RoFormer,
// or the test separator with ?model=test, and a run that fails the broken-run
// check shows the rule and the value it measured. With ?backend=wasm, the separator runs on
// WebAssembly even when the browser has a GPU.
@Component({
  selector: 'lyre-separation-check',
  imports: [MatButton, MatProgressBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <h2>{{ messages.separationCheckTitle }}</h2>
    <p>{{ messages.separationCheckAbout }}</p>
    <button matButton="filled" type="button" (click)="fileInput.click()">
      {{ messages.chooseSource }}
    </button>
    <input
      #fileInput
      type="file"
      accept="video/mp4,video/webm,audio/mpeg,.mp4,.webm,.mp3"
      hidden
      (change)="separate(fileInput)"
    />
    @switch (current.status) {
      @case ('preparing') {
        <p role="status">{{ messages.separationPreparing }}</p>
      }
      @case ('broken-run') {
        <p role="alert">{{ messages.brokenRun[current.rule](brokenRunText(current.rule, current.value)) }}</p>
      }
      @case ('failed') {
        <p role="alert">{{ failure(current.problem) }}</p>
      }
    }
    @if (current.status === 'running' || current.status === 'separated') {
      @let progress = current.progress;
      @let backend = messages.backendNames[progress.backend];
      <mat-progress-bar
        mode="determinate"
        [value]="(progress.done / progress.total) * 100"
        [attr.aria-label]="messages.separationProgress"
      />
      <p role="status">
        @if (current.status === 'running') {
          {{ messages.separationRunning(backend, progress.done, progress.total) }}
        } @else {
          {{ messages.separationDone(backend, progress.done, progress.total) }}
        }
      </p>
      @if (current.status === 'separated') {
        @let lengths = current.lengths;
        <!-- Each value is alone in its row, so the row's text is exactly the value. -->
        <dl [attr.aria-label]="messages.separatedAudio">
          <dt id="separation-backend">{{ messages.separationBackend }}</dt>
          <dd aria-labelledby="separation-backend">{{ backend }}</dd>
          <dt id="separation-source-length">{{ messages.separationSourceLength }}</dt>
          <dd aria-labelledby="separation-source-length">{{ messages.seconds(lengths.sourceSeconds.toFixed(2)) }}</dd>
          <dt id="separation-vocals-length">{{ messages.separationVocalsLength }}</dt>
          <dd aria-labelledby="separation-vocals-length">{{ messages.seconds(lengths.vocalsSeconds.toFixed(2)) }}</dd>
          <dt id="separation-karaoke-length">{{ messages.separationKaraokeLength }}</dt>
          <dd aria-labelledby="separation-karaoke-length">
            {{ messages.seconds(lengths.karaokeSeconds.toFixed(2)) }}
          </dd>
        </dl>
      }
    }
  `,
})
export class SeparationCheck {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'empty' })
  private readonly models = inject(Models)
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap
  private readonly test = this.query.get('model') === 'test'
  private readonly forced: Backend | undefined = this.query.get('backend') === 'wasm' ? 'wasm' : undefined
  // Counts the sources picked, so only the latest run shows.
  private attempts = 0
  // The separation running, if any.
  private run: SeparationRun | undefined

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      // A run's stopped answer then shows nowhere.
      this.attempts++
      this.stop()
    })
  }

  protected async separate(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again separates it again.
    input.value = ''
    if (!file) return
    this.stop()
    const attempt = ++this.attempts
    this.state.set({ status: 'preparing' })
    const run = runSeparation(
      this.models,
      file,
      { test: this.test, forced: this.forced },
      ({ backend, done, total }) => {
        if (attempt === this.attempts) this.state.set({ status: 'running', progress: { backend, done, total } })
      },
    )
    this.run = run
    const reply = await run.reply
    if (attempt !== this.attempts) return
    this.run = undefined
    switch (reply.type) {
      case 'separated': {
        const { backend, sourceSeconds, vocalsSeconds, karaokeSeconds } = reply
        const current = this.state()
        // The worker answers in order, so the last progress reply already counted every segment.
        const progress = current.status === 'running' ? current.progress : { backend, done: 0, total: 0 }
        this.state.set({
          status: 'separated',
          progress,
          lengths: { sourceSeconds, vocalsSeconds, karaokeSeconds },
        })
        break
      }
      case 'broken-run':
        this.state.set({ status: 'broken-run', rule: reply.rule, value: reply.value })
        break
      case 'failed':
        this.state.set({ status: 'failed', problem: reply.problem })
        break
    }
  }

  protected readonly brokenRunText = brokenRunValue

  protected failure(problem: SourceProblem | 'model'): string {
    if (problem === 'model') return messages.separatorNotLoaded
    return problem === 'no-audio' ? messages.sourceNoAudio : messages.sourceUnreadable
  }

  private stop(): void {
    this.run?.stop()
    this.run = undefined
  }
}
