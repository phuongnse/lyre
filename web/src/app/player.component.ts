import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core'
import { MatButton } from '@angular/material/button'
import { SONG_FILE_OPENER } from '../core'
import { OpenedSong, SongFileError, SongFileProblem } from '../song-file'
import { playSong } from './media-source-playback'
import { messages } from './messages'

type State =
  | { status: 'empty' }
  | { status: 'opening' }
  | { status: 'ready'; song: OpenedSong }
  | { status: 'failed'; problem: SongFileProblem }

// The Player: opens a song file and plays its video with the karaoke track.
@Component({
  selector: 'lyre-player',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <button matButton="filled" type="button" [disabled]="current.status === 'opening'" (click)="fileInput.click()">
      {{ messages.openSongFile }}
    </button>
    <input #fileInput type="file" accept=".lyre" hidden (change)="open(fileInput)" />
    @switch (current.status) {
      @case ('opening') {
        <p role="status">{{ messages.songFileOpening }}</p>
      }
      @case ('failed') {
        <p role="alert">
          {{ current.problem === 'not-a-song-file' ? messages.songFileNotASongFile : messages.songFileDamaged }}
        </p>
      }
      @case ('ready') {
        <video
          #video
          [attr.aria-label]="messages.songVideo"
          (play)="playing.set(true)"
          (pause)="playing.set(false)"
          (ended)="playing.set(false)"
        ></video>
        <button matButton="tonal" type="button" (click)="togglePlay()">
          {{ playing() ? messages.pause : messages.play }}
        </button>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    video {
      display: block;
      width: 100%;
    }
  `,
})
export class Player {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'empty' })
  protected readonly playing = signal(false)
  private readonly openSongFile = inject(SONG_FILE_OPENER)
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video')

  constructor() {
    // Streams the song once its video element exists, and stops when either goes.
    effect((onCleanup) => {
      const current = this.state()
      const video = this.video()?.nativeElement
      if (current.status !== 'ready' || !video) return
      onCleanup(playSong(video, current.song, () => this.fail(current.song)))
    })
    inject(DestroyRef).onDestroy(() => this.leave())
  }

  protected async open(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so choosing the same file again opens it again.
    input.value = ''
    if (!file) return
    this.leave({ status: 'opening' })
    try {
      const song = await this.openSongFile(file)
      if (this.state().status === 'opening') this.leave({ status: 'ready', song })
      else song.close()
    } catch (error) {
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SongFileError ? error.problem : 'damaged'
      this.leave({ status: 'failed', problem })
    }
  }

  protected togglePlay(): void {
    const video = this.video()?.nativeElement
    if (!video) return
    if (video.paused) {
      // A refused play shows through the video's error event.
      video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }

  // Shows the damaged message when `song` is still the one playing.
  private fail(song: OpenedSong): void {
    const current = this.state()
    if (current.status === 'ready' && current.song === song) this.leave({ status: 'failed', problem: 'damaged' })
  }

  // Moves to `next`, and frees the song that was open.
  private leave(next?: State): void {
    const current = this.state()
    if (current.status === 'ready') current.song.close()
    this.playing.set(false)
    if (next) this.state.set(next)
  }
}
