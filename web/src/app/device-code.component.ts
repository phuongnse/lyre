import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { DEVICE_UNLOCK, DeviceOutcome } from './device-passkey'
import { messages } from './messages'

type State = { status: 'idle' } | { status: 'running' } | { status: 'done'; outcome: DeviceOutcome }

type Ready = Extract<DeviceOutcome, { result: 'ready' }>

// The blank border around a QR code, in modules. The reference sets it.
const quietZone = 4
// How many pixels a module takes on screen.
const modulePixels = 5

// The This device section (docs/ui-conventions.md#device-code). A press of the
// button asks the device's passkey for its unlock, because browsers ask for a
// passkey only after a user gesture.
@Component({
  selector: 'lyre-device-code',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="this-device-heading">
      <h2 id="this-device-heading">{{ messages.thisDevice }}</h2>
      <button matButton="filled" type="button" [disabled]="state().status === 'running'" (click)="show()">
        {{ messages.showDeviceCode }}
      </button>
      <p role="status">{{ statusText() }}</p>
      @if (ready(); as device) {
        <dl>
          <dt>{{ messages.deviceCodeLabel }}</dt>
          <dd>{{ device.deviceCode }}</dd>
          <dt>{{ messages.fingerprintLabel }}</dt>
          <dd>{{ device.fingerprint }}</dd>
        </dl>
        <!-- The QR code is black on white in every theme: a scanner cannot read light cells on a dark ground. -->
        <svg
          role="img"
          [attr.aria-label]="messages.deviceCodeQr"
          [attr.viewBox]="'0 0 ' + total() + ' ' + total()"
          [attr.width]="total() * modulePixels"
          [attr.height]="total() * modulePixels"
          shape-rendering="crispEdges"
        >
          <rect width="100%" height="100%" fill="#fff" />
          <path [attr.d]="qrPath()" fill="#000" />
        </svg>
        <button matButton="outlined" type="button" (click)="copy(device.deviceCode)">
          {{ messages.copyDeviceCode }}
        </button>
        <p role="status">{{ copyText() }}</p>
      }
    </section>
  `,
  styles: `
    dd {
      overflow-wrap: anywhere;
    }
  `,
})
export class DeviceCode {
  protected readonly messages = messages
  protected readonly modulePixels = modulePixels
  protected readonly state = signal<State>({ status: 'idle' })
  protected readonly copyState = signal<'idle' | 'copied' | 'refused'>('idle')
  protected readonly ready = computed((): Ready | undefined => {
    const current = this.state()
    return current.status === 'done' && current.outcome.result === 'ready' ? current.outcome : undefined
  })
  protected readonly total = computed(() => (this.ready()?.qr.size ?? 0) + 2 * quietZone)
  // One square for each dark module, as a single path.
  protected readonly qrPath = computed(() => {
    const qr = this.ready()?.qr
    if (!qr) return ''
    const squares: string[] = []
    qr.modules.forEach((dark, index) => {
      if (dark) squares.push(`M${(index % qr.size) + quietZone} ${Math.floor(index / qr.size) + quietZone}h1v1h-1z`)
    })
    return squares.join('')
  })
  protected readonly statusText = computed(() => {
    const current = this.state()
    if (current.status === 'running') return messages.deviceUnlockWaiting
    if (current.status !== 'done') return ''
    switch (current.outcome.result) {
      case 'prf-missing':
        return messages.deviceCodeNoPrf
      case 'refused-sync':
        return messages.deviceCodeCanSync
      case 'failed':
        return messages.deviceCodeFailed
      default:
        return ''
    }
  })
  protected readonly copyText = computed(() => {
    switch (this.copyState()) {
      case 'copied':
        return messages.deviceCodeCopied
      case 'refused':
        return messages.deviceCodeNotCopied
      default:
        return ''
    }
  })
  private readonly unlock = inject(DEVICE_UNLOCK)

  protected async show(): Promise<void> {
    this.state.set({ status: 'running' })
    this.copyState.set('idle')
    let outcome: DeviceOutcome
    try {
      outcome = await this.unlock()
    } catch {
      outcome = { result: 'failed' }
    }
    this.state.set({ status: 'done', outcome })
  }

  protected async copy(code: string): Promise<void> {
    // Outside a secure context the browser has no clipboard API, which counts as a refusal.
    if (!navigator.clipboard?.writeText) {
      this.copyState.set('refused')
      return
    }
    try {
      await navigator.clipboard.writeText(code)
      this.copyState.set('copied')
    } catch {
      this.copyState.set('refused')
    }
  }
}
