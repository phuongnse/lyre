import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle'
import { MatFormField, MatLabel } from '@angular/material/form-field'
import { MatInput } from '@angular/material/input'
import { MatProgressBar } from '@angular/material/progress-bar'
import { ActivatedRoute } from '@angular/router'
import { loadCore } from '../../core'
import { lyricsAreValid } from '../../lyrics-file'
import { candidateFiles, separatorFile } from '../../measurement/candidates'
import { ModelCheckFailed } from '../../models/model-download'
import { VocalRole } from '../../original-track-messages'
import { Backend } from '../../separation/backend'
import { SourceError, readSource } from '../../source'
import { readRequirements, Requirement } from '../../task/requirements'
import { secondsLeft, stagePercent, TaskRunner, TaskState } from '../../task/task-runner'
import { messages } from '../messages'
import { Models } from '../models'
import { detailsFromTags, songFileName } from '../song-details'
import { cannotPlayMessage, sourceProblemMessage } from '../source-messages'

type SourceState =
  { status: 'empty' } | { status: 'reading' } | { status: 'ready'; file: File } | { status: 'refused'; message: string }

type LyricsState = { status: 'empty' } | { status: 'reading' } | { status: 'valid'; file: File } | { status: 'invalid' }

// Where a press of Make the song is: checking the device, stopped by a
// requirement it does not meet, stopped by a task in another tab, loading the
// model files, stopped by one of them, or running the task, whose own state
// the runner keeps.
type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'unmet'; unmet: Requirement[] }
  | { status: 'downloading' }
  | { status: 'download-failed'; id: string; checkFailed: boolean }
  | { status: 'busy' }
  | { status: 'task' }

// The Make a song section of the main page
// (docs/ui-conventions.md#making-a-song). The owner picks a source and the
// lyrics, edits the song details and chooses a vocal role. The source is read
// on the main thread as soon as it is picked, stage 1, and the lyrics are
// checked through the core. Make the song first checks that the device meets
// the requirements of D25, and then that no other tab holds the task lock. It
// starts nothing if either fails. It then loads the model files, which the
// page checks, and runs a task on them in a Web Worker. A failed task shows
// one alert that names its stage. Cancel works once
// the task has started. A finished task shows Done, hands its song file to the
// page through `made`, which opens it in the Player and keeps it in the
// library, and offers it as a download named after the source. A new run, a
// cancelled run and a failed run offer no download. ?model=test uses the test separator and test aligner,
// and ?backend=wasm skips the requirements check and runs the task on
// WebAssembly, both for the journeys. A
// source this browser refuses counts as no source and leaves the details
// fields as they are. The lyrics are kept as the File the owner picked, never
// as text, and never shown (D5).
// The main page loads this component's code only when the section first opens.
@Component({
  selector: 'lyre-make-song',
  imports: [MatButton, MatButtonToggleGroup, MatButtonToggle, MatFormField, MatLabel, MatInput, MatProgressBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let source = sourceState();
    @let lyrics = lyricsState();
    @let current = phase();
    @let task = runner.state();
    <h2>{{ messages.makeASong }}</h2>
    <button matButton="filled" type="button" [disabled]="source.status === 'reading'" (click)="sourceInput.click()">
      {{ messages.chooseSource }}
    </button>
    <input
      #sourceInput
      type="file"
      accept="video/mp4,video/webm,audio/mpeg,.mp4,.webm,.mp3"
      hidden
      (change)="readSourceFile(sourceInput)"
    />
    @switch (source.status) {
      @case ('reading') {
        <p role="status">{{ messages.sourceReading }}</p>
      }
      @case ('ready') {
        <p>{{ messages.pickedSource(source.file.name) }}</p>
      }
      @case ('refused') {
        <p role="alert">{{ source.message }}</p>
      }
    }
    <button matButton="filled" type="button" [disabled]="lyrics.status === 'reading'" (click)="lyricsInput.click()">
      {{ messages.chooseLyrics }}
    </button>
    <input #lyricsInput type="file" accept=".txt,text/plain" hidden (change)="readLyricsFile(lyricsInput)" />
    @switch (lyrics.status) {
      @case ('reading') {
        <p role="status">{{ messages.lyricsReading }}</p>
      }
      @case ('valid') {
        <p>{{ messages.pickedLyrics(lyrics.file.name) }}</p>
      }
      @case ('invalid') {
        <p role="alert">{{ messages.songLyricsInvalid }}</p>
      }
    }
    <mat-form-field>
      <mat-label>{{ messages.songTitle }}</mat-label>
      <input matInput #titleInput [value]="title()" (input)="title.set(titleInput.value)" />
    </mat-form-field>
    <mat-form-field>
      <mat-label>{{ messages.artist }}</mat-label>
      <input matInput #artistInput [value]="artist()" (input)="artist.set(artistInput.value)" />
    </mat-form-field>
    <mat-form-field>
      <mat-label>{{ messages.composer }}</mat-label>
      <input matInput #composerInput [value]="composer()" (input)="composer.set(composerInput.value)" />
    </mat-form-field>
    <mat-button-toggle-group
      [attr.aria-label]="messages.vocalRole"
      [value]="vocalRole()"
      (change)="vocalRole.set($event.value)"
    >
      <mat-button-toggle value="female">{{ messages.female }}</mat-button-toggle>
      <mat-button-toggle value="male">{{ messages.male }}</mat-button-toggle>
    </mat-button-toggle-group>
    <button matButton="filled" type="button" [disabled]="!canMake()" (click)="make()">
      {{ messages.makeTheSong }}
    </button>
    <button
      matButton
      type="button"
      [disabled]="current.status !== 'task' || task.status !== 'running'"
      (click)="runner.cancel()"
    >
      {{ messages.cancelTask }}
    </button>
    @if (current.status === 'unmet') {
      <p role="alert">{{ messages.cannotMakeSongs }} {{ unmetText(current.unmet) }}</p>
    }
    @if (current.status === 'busy') {
      <p role="alert">{{ messages.anotherTabMakingSong }}</p>
    }
    @if (current.status === 'downloading' || current.status === 'download-failed') {
      @if (bytes(); as bytes) {
        <mat-progress-bar
          mode="determinate"
          [value]="percent()"
          [attr.aria-label]="messages.modelProgress"
          [attr.aria-valuetext]="bytes"
        />
        <p>{{ bytes }}</p>
      }
    }
    @if (current.status === 'download-failed') {
      <p role="alert">
        {{ current.checkFailed ? messages.modelCheckFailed(current.id) : messages.modelDownloadFailed(current.id) }}
      </p>
    }
    @if (current.status === 'task') {
      <mat-progress-bar mode="determinate" [value]="stagePercent()" [attr.aria-label]="messages.taskProgress" />
      <p role="status">
        @switch (task.status) {
          @case ('running') {
            @if (task.report; as report) {
              {{ messages.taskStage(report.index + 1, report.count, stageName(report.stage)) }}
            }
          }
          @case ('done') {
            {{ messages.taskDone }}
          }
          @case ('cancelled') {
            {{ messages.taskCancelled }}
          }
        }
      </p>
      @if (task.status === 'failed') {
        <p role="alert">{{ failureText(task) }}</p>
      }
      @if (download(); as link) {
        <a matButton="filled" [href]="link.url" [download]="link.name">{{ messages.downloadSongFile }}</a>
      }
      <!-- Outside the status line, so a screen reader does not announce each update. -->
      @if (secondsLeft(); as seconds) {
        <p>{{ messages.taskTimeLeft(seconds) }}</p>
      }
    }
    @if (models.mayBeCleared()) {
      <p>{{ messages.modelsMayBeCleared }}</p>
    }
  `,
})
export class MakeSong {
  protected readonly messages = messages
  protected readonly sourceState = signal<SourceState>({ status: 'empty' })
  protected readonly lyricsState = signal<LyricsState>({ status: 'empty' })
  // The song details, exactly as typed or as the source's tags gave them.
  protected readonly title = signal('')
  protected readonly artist = signal('')
  protected readonly composer = signal('')
  // The role has no default, so a song is never made with a role nobody chose.
  protected readonly vocalRole = signal<VocalRole | undefined>(undefined)
  // A song needs an accepted source, valid lyrics, a title and a vocal role.
  protected readonly canMake = computed(
    () =>
      this.phase().status !== 'checking' &&
      this.phase().status !== 'downloading' &&
      this.runner.state().status !== 'running' &&
      this.sourceState().status === 'ready' &&
      this.lyricsState().status === 'valid' &&
      this.title() !== '' &&
      this.vocalRole() !== undefined,
  )
  protected readonly models = inject(Models)
  protected readonly runner = inject(TaskRunner)
  protected readonly phase = signal<Phase>({ status: 'idle' })
  // The finished song as a download, named after the source of the run that made it.
  protected readonly download = signal<{ url: string; name: string } | undefined>(undefined)
  // The finished song file, handed to the page, which opens and keeps it.
  readonly made = output<Blob>()
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap
  private readonly test = this.query.get('model') === 'test'
  private readonly forced: Backend | undefined = this.query.get('backend') === 'wasm' ? 'wasm' : undefined
  // The bytes downloaded so far, which stay shown after the download ends.
  protected readonly bytes = computed(() => {
    const progress = this.models.progress()
    return progress && messages.modelDownloading(progress.id, progress.loadedBytes, progress.totalBytes)
  })
  protected readonly percent = computed(() => {
    const progress = this.models.progress()
    if (!progress) return 0
    return progress.totalBytes === 0 ? 100 : (progress.loadedBytes / progress.totalBytes) * 100
  })
  protected readonly stagePercent = computed(() => stagePercent(this.runner.state()))
  protected readonly secondsLeft = computed(() => secondsLeft(this.runner.state()))
  // Count the sources and the lyrics picked, so only the latest pick shows.
  private sourceAttempts = 0
  private lyricsAttempts = 0
  // The name of the source the current run was started with.
  private runSource = ''
  // The last song handed over, so one finished run is handed over once.
  private handled: Blob | undefined

  constructor() {
    // Hands over the song of a run this section started. The runner outlives
    // the section, so a run that ended before this section opened is not handed over.
    effect(() => {
      const task = this.runner.state()
      if (this.phase().status !== 'task' || task.status !== 'done' || task.song === undefined) return
      const song = task.song
      if (song === this.handled) return
      untracked(() => {
        this.handled = song
        this.setDownload({ url: URL.createObjectURL(song), name: songFileName(this.runSource) })
        this.made.emit(song)
      })
    })
    inject(DestroyRef).onDestroy(() => this.setDownload(undefined))
  }

  // Reads the picked source. An accepted source fills the details fields from
  // its tags, replacing what they held. A refused source counts as no source
  // and leaves them alone.
  protected async readSourceFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again reads it again.
    input.value = ''
    if (!file) return
    const attempt = ++this.sourceAttempts
    this.sourceState.set({ status: 'reading' })
    try {
      // The core gives the stored types that the browser is asked about.
      await loadCore()
      const details = await readSource(file)
      if (attempt !== this.sourceAttempts) return
      if (details.cannotPlay !== undefined) {
        this.sourceState.set({ status: 'refused', message: cannotPlayMessage(details.cannotPlay) })
        return
      }
      const fields = detailsFromTags(details, file.name)
      this.title.set(fields.title)
      this.artist.set(fields.artist)
      this.composer.set(fields.composer)
      this.sourceState.set({ status: 'ready', file })
    } catch (error) {
      if (attempt !== this.sourceAttempts) return
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SourceError ? error.problem : 'unreadable'
      this.sourceState.set({ status: 'refused', message: sourceProblemMessage(problem) })
    }
  }

  // Checks the picked lyrics through the core. The File is kept, never its text.
  protected async readLyricsFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again reads it again.
    input.value = ''
    if (!file) return
    const attempt = ++this.lyricsAttempts
    this.lyricsState.set({ status: 'reading' })
    let valid = false
    try {
      await loadCore()
      valid = await lyricsAreValid(file)
    } catch {
      // The lyrics cannot be checked, so they do not count as valid.
    }
    if (attempt !== this.lyricsAttempts) return
    this.lyricsState.set(valid ? { status: 'valid', file } : { status: 'invalid' })
  }

  protected stageName(stage: string): string {
    return (messages.stageNames as Record<string, string | undefined>)[stage] ?? stage
  }

  // The one message for a failed task. It names the stage and, for a syllable
  // the aligner cannot time, its place. It never holds lyric text or the core's own text.
  protected failureText(task: Extract<TaskState, { status: 'failed' }>): string {
    if (task.reason === 'another-task-running') return messages.anotherTabMakingSong
    const stage = task.stage === undefined ? undefined : messages.songStageFailures[task.stage]
    if (stage === undefined) return messages.songNotMade
    const failed = messages.songFailed(stage)
    return task.unknown === undefined
      ? failed
      : `${failed} ${messages.unknownSyllable(task.unknown.lyricLine + 1, task.unknown.syllable + 1)}`
  }

  protected unmetText(unmet: Requirement[]): string {
    return unmet.map((requirement) => messages.unmetRequirements[requirement]).join(' ')
  }

  // Checks the device and the task lock, then loads the separator's file and the aligner's model
  // and vocabulary, then runs the task on them. A device that falls short, or
  // any file that fails, stops the run before a stage.
  protected async make(): Promise<void> {
    const source = this.sourceState()
    const lyrics = this.lyricsState()
    const vocalRole = this.vocalRole()
    if (source.status !== 'ready' || lyrics.status !== 'valid' || vocalRole === undefined || !this.canMake()) return
    this.setDownload(undefined)
    // What the owner entered when they pressed the button.
    const details = { title: this.title(), artist: this.artist(), composer: this.composer() }
    this.phase.set({ status: 'checking' })
    // Only a journey forces a backend, and it runs on machines without a GPU.
    if (this.forced === undefined) {
      const unmet = await readRequirements()
      if (unmet.length > 0) {
        this.phase.set({ status: 'unmet', unmet })
        return
      }
    }
    // Before any download, so a start that is refused fetches nothing.
    if (await this.runner.anotherTaskRunning()) {
      this.phase.set({ status: 'busy' })
      return
    }
    this.phase.set({ status: 'downloading' })
    const files = candidateFiles[this.test ? 'test-lyric-alignment' : 'lyric-alignment-fp32']
    let id = ''
    const load = async (next: string) => {
      id = next
      return this.models.load(next)
    }
    let loaded: { separator: Blob; model: Blob; vocabulary: Blob }
    try {
      loaded = {
        separator: await load(separatorFile(this.test)),
        model: await load(files.graph),
        vocabulary: await load(files.vocabulary),
      }
    } catch (error) {
      // Any other failure, such as storage the browser blocks, also keeps nothing.
      this.phase.set({ status: 'download-failed', id, checkFailed: error instanceof ModelCheckFailed })
      return
    }
    // The lyrics' bytes go to the task as they are (D5).
    const bytes = new Uint8Array(await lyrics.file.arrayBuffer())
    this.runSource = source.file.name
    this.runner.start({
      input: {
        source: source.file,
        lyrics: bytes,
        details,
        vocalRole,
        separator: loaded.separator,
        aligner: { kind: files.kind, model: loaded.model, vocabulary: loaded.vocabulary },
      },
      backend: this.forced,
    })
    this.phase.set({ status: 'task' })
  }

  // Replaces the download and revokes the earlier link's blob URL.
  private setDownload(next: { url: string; name: string } | undefined): void {
    const previous = this.download()
    if (previous !== undefined) URL.revokeObjectURL(previous.url)
    this.download.set(next)
  }
}
