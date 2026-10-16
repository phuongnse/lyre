import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle'
import { MatFormField, MatLabel } from '@angular/material/form-field'
import { MatInput } from '@angular/material/input'
import { SONG_FILE_OPENER } from '../core'
import { KeptSong } from '../library-store'
import { ByteSource, OpenedSong, ShareError, SongFileError, SongFileProblem } from '../song-file'
import { DEVICE_KEY } from './device-passkey'
import { Library } from './library'
import { LibraryList } from './library.component'
import { Lyrics } from './lyrics.component'
import { Playback, playSong, SongMedia, unplayableMedia } from './media-source-playback'
import { messages } from './messages'

type State =
  | { status: 'empty' }
  | { status: 'opening' }
  | { status: 'ready'; song: OpenedSong }
  | { status: 'failed'; problem: SongFileProblem }
  | { status: 'unplayable'; media: SongMedia }

// The share form: nothing asked yet, a refusal, or the other device's
// fingerprint with the access file to download.
type ShareState =
  | { status: 'idle' }
  | { status: 'invalid' }
  | { status: 'failed' }
  | { status: 'done'; fingerprint: string; url: string; name: string }

type AudioTrackChoice = 'karaoke' | 'original'

// The Player: opens a song file with its access files, or a song from the
// library, and plays its video with the karaoke track or the original track,
// with its lyrics over the bottom of the video. A song file that opens, and that
// this browser can play, is kept in the library, with the access file that
// opened it. A version-0 file is refused, whether it is opened or kept. A song
// made on this page opens the same way, with the access file the task made. Given
// a song through its input, as the check pages do, it plays only that song: it
// keeps nothing in the library, and has no open button or library list. With an
// access file through its input too, the song opens with device access, like a
// version-1 song the owner opens. Without one, it plays from memory. A song
// the owner opened with an owner access file offers Share, which gives a
// recipient access file for another device's code. A song opened with a
// recipient access file, or given through the input, offers none.
@Component({
  selector: 'lyre-player',
  imports: [MatButton, MatButtonToggleGroup, MatButtonToggle, MatFormField, MatLabel, MatInput, LibraryList, Lyrics],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    @if (!song()) {
      <button matButton="filled" type="button" [disabled]="current.status === 'opening'" (click)="fileInput.click()">
        {{ messages.openSongFile }}
      </button>
      <input #fileInput type="file" accept=".lyre,.lyrekey" multiple hidden (change)="open(fileInput)" />
      <lyre-library (choose)="openKept($event)" />
    }
    @switch (current.status) {
      @case ('opening') {
        <p role="status">{{ messages.songFileOpening }}</p>
      }
      @case ('failed') {
        <p role="alert">
          {{ problemMessage(current.problem) }}
        </p>
      }
      @case ('unplayable') {
        <p role="alert">{{ messages.cannotPlay[current.media] }}</p>
      }
      @case ('ready') {
        <div class="stage">
          <video
            #video
            [attr.aria-label]="messages.songVideo"
            (play)="playing.set(true)"
            (pause)="playing.set(false)"
            (ended)="playing.set(false)"
          ></video>
          <lyre-lyrics [song]="current.song" [video]="video" />
        </div>
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
        @if (!song() && current.song.share) {
          @if (!sharing()) {
            <button matButton="tonal" type="button" (click)="sharing.set(true)">{{ messages.share }}</button>
          } @else {
            <section aria-labelledby="share-heading">
              <h2 id="share-heading">{{ messages.shareTitle }}</h2>
              <p>{{ messages.shareCannotUndo }}</p>
              <mat-form-field>
                <mat-label>{{ messages.shareDeviceCode }}</mat-label>
                <input
                  matInput
                  #codeInput
                  autocomplete="off"
                  spellcheck="false"
                  (input)="shareState.set({ status: 'idle' })"
                />
              </mat-form-field>
              <button matButton="filled" type="button" (click)="share(current.song, codeInput.value)">
                {{ messages.makeAccessFile }}
              </button>
              @let result = shareState();
              @switch (result.status) {
                @case ('invalid') {
                  <p role="alert">{{ messages.shareInvalidCode }}</p>
                }
                @case ('failed') {
                  <p role="alert">{{ messages.shareFailed }}</p>
                }
                @case ('done') {
                  <dl>
                    <dt>{{ messages.fingerprintLabel }}</dt>
                    <dd>{{ result.fingerprint }}</dd>
                  </dl>
                  <p>{{ messages.shareCompare }}</p>
                  <a matButton="filled" [href]="result.url" [download]="result.name">{{
                    messages.downloadAccessFile
                  }}</a>
                }
              }
            </section>
          }
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .stage {
      position: relative;
    }
    video {
      display: block;
      width: 100%;
    }
    lyre-lyrics {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
    }
  `,
})
export class Player {
  // A song to play without keeping it, such as a measured song.
  readonly song = input<Blob>()
  // The access file of that song, when it is a version-1 song to open with device access.
  readonly access = input<Blob>()
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'empty' })
  protected readonly playing = signal(false)
  protected readonly track = signal<AudioTrackChoice>('karaoke')
  protected readonly sharing = signal(false)
  protected readonly shareState = signal<ShareState>({ status: 'idle' })
  private readonly openSongFile = inject(SONG_FILE_OPENER)
  private readonly library = inject(Library)
  private readonly deviceKey = inject(DEVICE_KEY)
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
    // A song given through the input is never kept in the library.
    effect(() => {
      const song = this.song()
      const access = this.access()
      if (song) untracked(() => void this.openSource(song, access && { files: [access] }))
    })
    inject(DestroyRef).onDestroy(() => this.leave())
  }

  protected async open(input: HTMLInputElement): Promise<void> {
    // The extension only sorts the files into two kinds. The core matches an
    // access file to its song by song ID.
    const chosen = Array.from(input.files ?? [])
    // Clears the choice, so choosing the same file again opens it again.
    input.value = ''
    const isAccessFile = (file: File) => file.name.toLowerCase().endsWith('.lyrekey')
    const file = chosen.find((candidate) => !isAccessFile(candidate))
    if (file) await this.openSource(file, { files: chosen.filter(isAccessFile), keep: file })
  }

  // Opens a song kept in the library, with the access file it was kept with.
  protected openKept(kept: KeptSong): Promise<void> {
    return this.openSource(kept.file, { files: kept.accessFile ? [kept.accessFile] : [] })
  }

  protected problemMessage(problem: SongFileProblem): string {
    switch (problem) {
      case 'not-a-song-file':
        return messages.songFileNotASongFile
      case 'cannot-open':
        return messages.songCannotOpen
      case 'old-version':
        return messages.songFileOldVersion
      default:
        return messages.songFileDamaged
    }
  }

  // Opens a song file made on this page with its access file, and keeps both in
  // the library, like any version-1 song the owner opens.
  openMade(file: Blob, accessFile: Blob): Promise<void> {
    return this.openSource(file, { files: [accessFile], keep: file })
  }

  // Opens `source`. With `chosen`, the song opens with device access and the
  // chosen access `files`, and when it opens and `keep` is set, `keep` goes
  // into the library. Without `chosen`, the song is one given through the
  // input: it opens without device access and is never kept.
  protected async openSource(source: ByteSource, chosen?: { files: readonly Blob[]; keep?: Blob }): Promise<void> {
    const attempt = ++this.attempts
    this.leave({ status: 'opening' })
    try {
      const song = await this.openSongFile(source, chosen && { files: chosen.files, key: this.deviceKey })
      if (attempt !== this.attempts || this.state().status !== 'opening') {
        song.close()
        return
      }
      // Nothing plays, and the song is not kept, when a track cannot play here.
      const media = unplayableMedia(song)
      if (media) {
        song.close()
        this.leave({ status: 'unplayable', media })
        return
      }
      this.leave({ status: 'ready', song })
      // Playback does not wait for the library, and never fails because of it.
      if (chosen?.keep) void this.library.keep(song, chosen.keep)
    } catch (error) {
      if (attempt !== this.attempts) return
      // The error's own text is never shown: it is not meant for users.
      const problem = error instanceof SongFileError ? error.problem : 'damaged'
      this.leave({ status: 'failed', problem })
    }
  }

  // Shares `song` with the device that has `deviceCode`. The core checks the
  // code and makes the access file. Nothing is offered for a code it refuses.
  protected async share(song: OpenedSong, deviceCode: string): Promise<void> {
    if (!song.share) return
    this.setShare({ status: 'idle' })
    try {
      const shared = await song.share(deviceCode.trim())
      const current = this.state()
      if (current.status !== 'ready' || current.song !== song) return
      const name = `${song.details.title.trim() || 'song'}.lyrekey`
      this.setShare({
        status: 'done',
        fingerprint: shared.fingerprint,
        url: URL.createObjectURL(shared.accessFile),
        name,
      })
    } catch (error) {
      const current = this.state()
      if (current.status !== 'ready' || current.song !== song) return
      this.setShare({ status: error instanceof ShareError && error.problem === 'invalid-code' ? 'invalid' : 'failed' })
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
    this.sharing.set(false)
    this.setShare({ status: 'idle' })
    if (next) this.state.set(next)
  }

  // Replaces the share state and revokes the earlier download's blob URL.
  private setShare(next: ShareState): void {
    const previous = this.shareState()
    if (previous.status === 'done') URL.revokeObjectURL(previous.url)
    this.shareState.set(next)
  }
}
