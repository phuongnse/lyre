import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatFormField, MatLabel } from '@angular/material/form-field'
import { MatInput } from '@angular/material/input'
import { messages } from './messages'
import { SONG_RESTORER } from './restore-songs'

type Result = { name: string; restored: boolean }

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'words-refused' }
  | { status: 'no-device' }
  | { status: 'done'; results: Result[] }

// The Restore songs section (docs/ui-conventions.md#restoring-songs). The owner
// types the recovery words, or pastes the text of the QR code, and chooses song
// files. The words go to the restorer and nowhere else: the field is emptied
// the moment Restore is pressed, and nothing is logged. A failed restore shows
// one plain message, never an error's text.
@Component({
  selector: 'lyre-restore-songs',
  imports: [MatButton, MatFormField, MatLabel, MatInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="restore-songs-heading">
      <h2 id="restore-songs-heading">{{ messages.restoreSongs }}</h2>
      <p>{{ messages.restoreAbout }}</p>
      <mat-form-field>
        <mat-label>{{ messages.restoreWords }}</mat-label>
        <textarea matInput #words autocomplete="off" spellcheck="false" rows="3"></textarea>
      </mat-form-field>
      <button matButton="outlined" type="button" [disabled]="running()" (click)="fileInput.click()">
        {{ messages.chooseSongFiles }}
      </button>
      <input #fileInput type="file" accept=".lyre" multiple hidden (change)="choose(fileInput)" />
      <p role="status">{{ files().length > 0 ? messages.chosenSongFiles(files().length) : '' }}</p>
      <button matButton="filled" type="button" [disabled]="running()" (click)="restore(words)">
        {{ messages.restoreTheSongs }}
      </button>
      @let current = state();
      @switch (current.status) {
        @case ('running') {
          <p role="status">{{ messages.restoring }}</p>
        }
        @case ('words-refused') {
          <p role="alert">{{ messages.restoreWordsRefused }}</p>
        }
        @case ('no-device') {
          <p role="alert">{{ messages.restoreNoDevice }}</p>
        }
        @case ('done') {
          <ul [attr.aria-label]="messages.restoreResults">
            @for (result of current.results; track $index) {
              <li>
                {{ result.restored ? messages.songRestored(result.name) : messages.songNotRestored(result.name) }}
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
})
export class RestoreSongs {
  // Fires when a restore kept the recovery public key on this device.
  readonly keyKept = output<void>()
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'idle' })
  protected readonly files = signal<File[]>([])
  private readonly restoreSongs = inject(SONG_RESTORER)

  protected running(): boolean {
    return this.state().status === 'running'
  }

  protected choose(input: HTMLInputElement): void {
    const chosen = Array.from(input.files ?? [])
    // Clears the choice, so the same files can be picked again.
    input.value = ''
    if (chosen.length > 0) this.files.set(chosen)
  }

  protected async restore(words: HTMLTextAreaElement): Promise<void> {
    if (this.running()) return
    const text = words.value
    words.value = ''
    this.state.set({ status: 'running' })
    try {
      const outcome = await this.restoreSongs(text, this.files())
      if (outcome.status === 'done') {
        this.state.set({ status: 'done', results: outcome.results })
        if (outcome.keptKey) this.keyKept.emit()
      } else {
        this.state.set({ status: outcome.status })
      }
    } catch {
      // The restorer fails only when the core cannot load. No song was restored.
      this.state.set({ status: 'no-device' })
    }
  }
}
