import { ChangeDetectionStrategy, Component } from '@angular/core'
import { CoreVersion } from './core-version.component'
import { Player } from './player.component'

@Component({
  selector: 'lyre-home',
  imports: [CoreVersion, Player],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <lyre-core-version />
    <lyre-player />
  `,
})
export class Home {}
