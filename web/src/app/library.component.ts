import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { KeptSong } from '../library-store'
import { Library } from './library'
import { messages } from './messages'

// Lists the songs kept on this device, with their details exactly as stored.
// A song kept without an access file is version 0 and is marked as no longer
// playing. Choosing one emits it, for the Player to play or refuse.
@Component({
  selector: 'lyre-library',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (library.songs().length > 0) {
      @if (library.mayBeCleared()) {
        <p>{{ messages.libraryMayBeCleared }}</p>
      }
      <ul [attr.aria-label]="messages.library">
        @for (song of library.songs(); track song.songId) {
          <li>
            <button matButton type="button" (click)="choose.emit(song)">{{ song.title }}</button>
            @if (!song.accessFile) {
              <span>{{ messages.songNoLongerPlays }}</span>
            }
            @if (song.artist) {
              <span>{{ messages.songArtist(song.artist) }}</span>
            }
            @if (song.composer) {
              <span>{{ messages.songComposer(song.composer) }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    ul {
      padding: 0;
      list-style: none;
    }
    span {
      display: block;
    }
  `,
})
export class LibraryList {
  protected readonly messages = messages
  protected readonly library = inject(Library)
  readonly choose = output<KeptSong>()
}
