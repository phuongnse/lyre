import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { CORE_VERSION_LOADER } from '../core'
import { messages } from './messages'

type State = { status: 'loading' } | { status: 'ready'; version: string } | { status: 'failed' }

@Component({
  selector: 'lyre-core-version',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    @switch (current.status) {
      @case ('loading') {
        <p>{{ messages.coreLoading }}</p>
      }
      @case ('ready') {
        <p>{{ messages.coreVersion(current.version) }}</p>
      }
      @case ('failed') {
        <p>{{ messages.coreFailed }}</p>
      }
    }
  `,
})
export class CoreVersion {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'loading' })

  constructor() {
    // The error is not shown: its details are not for the user.
    inject(CORE_VERSION_LOADER)().then(
      (version) => this.state.set({ status: 'ready', version }),
      () => this.state.set({ status: 'failed' }),
    )
  }
}
