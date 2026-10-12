import { ChangeDetectionStrategy, Component } from '@angular/core'
import { CoreVersion } from './core-version.component'

@Component({
  selector: 'lyre-home',
  imports: [CoreVersion],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<lyre-core-version />`,
})
export class Home {}
