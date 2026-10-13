import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatProgressBar } from '@angular/material/progress-bar'
import { ModelCheckFailed } from '../../models/model-download'
import { messages } from '../messages'
import { Models } from '../models'

// The test entry the page downloads: the 56-byte two-block test vector.
const TEST_MODEL = 'test-two-block'

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'passed' }
  | { status: 'check-failed' }
  | { status: 'download-failed' }

// The model check page (docs/ui-conventions.md#check-pages). It downloads,
// checks and keeps a pinned test file, until the real models are added.
// Opened by its URL, #/model-check.
@Component({
  selector: 'lyre-model-check',
  imports: [MatButton, MatProgressBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <h2>{{ messages.modelCheckTitle }}</h2>
    <p>{{ messages.modelCheckAbout }}</p>
    <button matButton="filled" type="button" [disabled]="current.status === 'running'" (click)="load()">
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
}
