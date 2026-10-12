import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { messages } from '../messages'
import { Outcome, PASSKEY_CHECK } from './passkey-check'

type State = { status: 'idle' } | { status: 'running' } | { status: 'done'; outcome: Outcome }

// What Chromium-based browsers say about themselves beyond the user agent string.
// lib.dom does not declare it yet.
type UserAgentData = { platform: string; brands: { brand: string; version: string }[] }

// The passkey check page (docs/roadmap.md#early-checks-on-real-devices). The
// owner opens it by its URL, #/passkey-check, and runs it on each device.
@Component({
  selector: 'lyre-passkey-check',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <h2>{{ messages.passkeyCheckTitle }}</h2>
    <h3>{{ messages.browserAndOs }}</h3>
    <p>{{ userAgent }}</p>
    @if (userAgentData; as data) {
      <p>{{ messages.userAgentPlatform(data.platform) }}</p>
      <p>{{ messages.userAgentBrands(brands(data)) }}</p>
    }
    <!-- A click starts the check, because Safari asks for passkeys only after a user gesture. -->
    <button matButton="filled" type="button" [disabled]="current.status === 'running'" (click)="run()">
      {{ messages.runPasskeyCheck }}
    </button>
    <p role="status">
      @switch (current.status) {
        @case ('running') {
          {{ messages.passkeyChecking }}
        }
        @case ('done') {
          @switch (current.outcome.result) {
            @case ('works') {
              {{ messages.passkeyWorks }}
            }
            @case ('refused-sync') {
              {{ messages.passkeyRefusedSync }}
            }
            @case ('prf-missing') {
              {{ messages.passkeyPrfMissing }}
            }
            @case ('failed') {
              {{ messages.passkeyFailed(current.outcome.errorName) }}
            }
          }
        }
      }
    </p>
    @if (flags(); as known) {
      <p>{{ messages.backupEligible(known.eligible) }}</p>
      <p>{{ messages.backedUp(known.state) }}</p>
    }
    <p>{{ messages.passkeyLeftBehind }}</p>
  `,
})
export class PasskeyCheck {
  protected readonly messages = messages
  protected readonly state = signal<State>({ status: 'idle' })
  protected readonly flags = computed(() => {
    const current = this.state()
    return current.status === 'done' && current.outcome.result !== 'failed' ? current.outcome.flags : undefined
  })
  protected readonly userAgent = navigator.userAgent
  protected readonly userAgentData = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  private readonly check = inject(PASSKEY_CHECK)

  protected brands(data: UserAgentData): string {
    return data.brands.map(({ brand, version }) => `${brand} ${version}`).join(', ')
  }

  protected async run(): Promise<void> {
    this.state.set({ status: 'running' })
    const outcome = await this.check()
    this.state.set({ status: 'done', outcome })
  }
}
