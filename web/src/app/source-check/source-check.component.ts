import { ChangeDetectionStrategy, Component, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { SourceDetails, SourceError, SourceProblem, readSource } from '../../source'
import { messages } from '../messages'

type State =
  | { status: 'empty' }
  | { status: 'reading' }
  | { status: 'ready'; details: SourceDetails }
  | { status: 'failed'; problem: SourceProblem }

// The source check page (docs/ui-conventions.md#check-pages). It reads a
// picked source's details, stage 1 of processing, until the real song-making
// page exists. Opened by its URL, #/source-check. The route is lazy, so
// Mediabunny stays out of the main app's initial load.
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
      @case ('ready') {
        @let details = current.details;
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
      }
    }
  `,
})
export class SourceCheck {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'empty' })
  // Counts the sources picked, so only the latest one shows.
  private attempts = 0

  protected async read(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so picking the same file again reads it again.
    input.value = ''
    if (!file) return
    const attempt = ++this.attempts
    this.state.set({ status: 'reading' })
    try {
      const details = await readSource(file)
      if (attempt === this.attempts) this.state.set({ status: 'ready', details })
    } catch (error) {
      if (attempt !== this.attempts) return
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SourceError ? error.problem : 'unreadable'
      this.state.set({ status: 'failed', problem })
    }
  }
}
