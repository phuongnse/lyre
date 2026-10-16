import { ChangeDetectionStrategy, Component, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { CoreVersion } from './core-version.component'
import { DeviceCode } from './device-code.component'
import { MakeSong } from './make-song/make-song.component'
import { messages } from './messages'
import { Player } from './player.component'
import { RecoveryKey } from './recovery-key.component'

// The main page. The Make a song section opens on the first press of its
// button, and its code loads then (docs/ui-conventions.md#making-a-song).
// `MakeSong` is named only in `imports` and inside `@defer`, so Angular keeps
// it out of the page's initial load.
@Component({
  selector: 'lyre-home',
  imports: [CoreVersion, Player, DeviceCode, RecoveryKey, MatButton, MakeSong],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <lyre-core-version />
    <lyre-player #player />
    <lyre-device-code />
    <lyre-recovery-key />
    @if (makingSong()) {
      @defer (on immediate) {
        <lyre-make-song (made)="player.openMade($event.song, $event.accessFile)" />
      }
    } @else {
      <button matButton="filled" type="button" (click)="makingSong.set(true)">{{ messages.makeASong }}</button>
    }
  `,
})
export class Home {
  protected readonly messages = messages
  protected readonly makingSong = signal(false)
}
