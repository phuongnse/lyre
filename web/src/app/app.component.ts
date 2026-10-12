import { ChangeDetectionStrategy, Component } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { messages } from './messages'

@Component({
  selector: 'lyre-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>{{ messages.appTitle }}</h1>
    <router-outlet />
  `,
})
export class App {
  protected readonly messages = messages
}
