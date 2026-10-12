import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle'
import { SONG_FILE_OPENER } from '../core'
import { ByteSource, OpenedSong, SongFileError, SongFileProblem } from '../song-file'
import { Library } from './library'
import { LibraryList } from './library.component'
import { Lyrics } from './lyrics.component'
import { Playback, playSong } from './media-source-playback'
import { messages } from './messages'

type State =
  | { status: 'empty' }
  | { status: 'opening' }
  | { status: 'ready'; song: OpenedSong }
  | { status: 'failed'; problem: SongFileProblem }

type AudioTrackChoice = 'karaoke' | 'original'

// The Player: opens a song file, or a song from the library, and plays its
// video with the karaoke track or the original track, with its lyrics under the
// video. A song file that opens is kept in the library.
@Component({
  selector: 'lyre-player',
  imports: [MatButton, MatButtonToggleGroup, MatButtonToggle, LibraryList, Lyrics],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <button matButton="filled" type="button" [disabled]="current.status === 'opening'" (click)="fileInput.click()">
      {{ messages.openSongFile }}
    </button>
    <input #fileInput type="file" accept=".lyre" hidden (change)="open(fileInput)" />
    <lyre-library (choose)="openSource($event.file)" />
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
        <lyre-lyrics [song]="current.song" [video]="video" />
        <button matButton="tonal" type="button" (click)="togglePlay()">
          {{ playing() ? messages.pause : messages.play }}
        </button>
        <mat-button-toggle-group
          [attr.aria-label]="messages.audioTrack"
          [value]="track()"
          (change)="chooseTrack($event.value)"
        >
          <mat-button-toggle value="karaoke">{{ messages.karaoke }}</mat-button-toggle>
          <mat-button-toggle value="original">{{ messages.original }}</mat-button-toggle>
        </mat-button-toggle-group>
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
  protected readonly track = signal<AudioTrackChoice>('karaoke')
  private readonly openSongFile = inject(SONG_FILE_OPENER)
  private readonly library = inject(Library)
  // Counts the songs asked for, so only the latest one opens.
  private attempts = 0
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video')
  private playback?: Playback

  constructor() {
    // Streams the song once its video element exists, and stops when either goes.
    effect((onCleanup) => {
      const current = this.state()
      const video = this.video()?.nativeElement
      if (current.status !== 'ready' || !video) return
      // The track is read untracked, so a switch does not stream the song again.
      const track = current.song[untracked(this.track)]
      const playback = playSong(video, current.song, track, () => this.fail(current.song))
      this.playback = playback
      onCleanup(() => {
        playback.stop()
        if (this.playback === playback) this.playback = undefined
      })
    })
    inject(DestroyRef).onDestroy(() => this.leave())
  }

  protected async open(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    // Clears the choice, so choosing the same file again opens it again.
    input.value = ''
    if (file) await this.openSource(file, file)
  }

  // Opens `source`. When it is a chosen `file` that opens, keeps it in the library.
  protected async openSource(source: ByteSource, file?: Blob): Promise<void> {
    const attempt = ++this.attempts
    this.leave({ status: 'opening' })
    try {
      const song = await this.openSongFile(source)
      if (attempt !== this.attempts || this.state().status !== 'opening') {
        song.close()
        return
      }
      this.leave({ status: 'ready', song })
      // Playback does not wait for the library, and never fails because of it.
      if (file) void this.library.keep(song, file)
    } catch (error) {
      if (attempt !== this.attempts) return
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

  protected chooseTrack(choice: AudioTrackChoice): void {
    this.track.set(choice)
    const current = this.state()
    if (current.status === 'ready') this.playback?.switchAudio(current.song[choice])
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
    this.track.set('karaoke')
    if (next) this.state.set(next)
  }
}
