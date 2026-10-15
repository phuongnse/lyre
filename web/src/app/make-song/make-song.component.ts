import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle'
import { MatFormField, MatLabel } from '@angular/material/form-field'
import { MatInput } from '@angular/material/input'
import { loadCore } from '../../core'
import { lyricsAreValid } from '../../lyrics-file'
import { VocalRole } from '../../original-track-messages'
import { SourceError, readSource } from '../../source'
import { messages } from '../messages'
import { detailsFromTags } from '../song-details'
import { cannotPlayMessage, sourceProblemMessage } from '../source-messages'

type SourceState =
  { status: 'empty' } | { status: 'reading' } | { status: 'ready'; file: File } | { status: 'refused'; message: string }

type LyricsState = { status: 'empty' } | { status: 'reading' } | { status: 'valid'; file: File } | { status: 'invalid' }

// The Make a song section of the main page
// (docs/ui-conventions.md#making-a-song). The owner picks a source and the
// lyrics, edits the song details and chooses a vocal role. The source is read
// on the main thread as soon as it is picked, stage 1, and the lyrics are
// checked through the core. No task runs yet. A source this browser refuses
// counts as no source and leaves the details fields as they are. The lyrics
// are kept as the File the owner picked, never as text, and never shown (D5).
// The main page loads this component's code only when the section first opens.
@Component({
  selector: 'lyre-make-song',
  imports: [MatButton, MatButtonToggleGroup, MatButtonToggle, MatFormField, MatLabel, MatInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let source = sourceState();
    @let lyrics = lyricsState();
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
    <button matButton="filled" type="button" [disabled]="!canMake()">{{ messages.makeTheSong }}</button>
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
      this.sourceState().status === 'ready' &&
      this.lyricsState().status === 'valid' &&
      this.title() !== '' &&
      this.vocalRole() !== undefined,
  )
  // Count the sources and the lyrics picked, so only the latest pick shows.
  private sourceAttempts = 0
  private lyricsAttempts = 0

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
}
