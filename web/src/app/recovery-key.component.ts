import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { messages } from './messages'
import { keepRecoveryPublicKey, NewRecovery, RECOVERY_KEY_MAKER, readRecoveryPublicKey } from './recovery-key'

type State =
  | { status: 'none' }
  | { status: 'creating' }
  | ({ status: 'shown' } & NewRecovery)
  | { status: 'kept' }
  | { status: 'failed' }

// The blank border around a QR code, in modules. The reference sets it.
const quietZone = 4
// How many pixels a module takes on screen.
const modulePixels = 5

// The Recovery key section (docs/ui-conventions.md#recovery-key). The owner
// makes the key, sees its words and QR code once, and confirms they kept it.
// Only then does the page keep the public part. The words and the QR code live
// in a signal while they are shown, and leave it on confirm. Nothing is
// logged, and no error's text is shown.
@Component({
  selector: 'lyre-recovery-key',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="recovery-key-heading">
      <h2 id="recovery-key-heading">{{ messages.recoveryKey }}</h2>
      @switch (state().status) {
        @case ('kept') {
          <p>{{ messages.recoveryKeyKept }}</p>
        }
        @case ('shown') {
          <ol [attr.aria-label]="messages.recoveryWords">
            @for (word of words(); track $index) {
              <li>{{ word }}</li>
            }
          </ol>
          <!-- The QR code is black on white in every theme: a scanner cannot read light cells on a dark ground. -->
          <svg
            role="img"
            [attr.aria-label]="messages.recoveryKeyQr"
            [attr.viewBox]="'0 0 ' + total() + ' ' + total()"
            [attr.width]="total() * modulePixels"
            [attr.height]="total() * modulePixels"
            shape-rendering="crispEdges"
          >
            <rect width="100%" height="100%" fill="#fff" />
            <path [attr.d]="qrPath()" fill="#000" />
          </svg>
          <p>{{ messages.recoveryKeyKeepOffline }}</p>
          <button matButton="filled" type="button" (click)="keep()">{{ messages.keptRecoveryKey }}</button>
        }
        @default {
          <p>{{ messages.recoveryKeyAbout }}</p>
          @if (state().status === 'failed') {
            <p role="alert">{{ messages.recoveryKeyFailed }}</p>
          }
          <button matButton="filled" type="button" [disabled]="state().status === 'creating'" (click)="create()">
            {{ messages.createRecoveryKey }}
          </button>
          <p role="status">{{ state().status === 'creating' ? messages.recoveryKeyCreating : '' }}</p>
        }
      }
      <p>{{ messages.recoveryKeyLoss }}</p>
    </section>
  `,
  styles: `
    ol {
      columns: 3;
    }
  `,
})
export class RecoveryKey {
  protected readonly messages = messages
  protected readonly modulePixels = modulePixels
  protected readonly state = signal<State>({
    status: readRecoveryPublicKey() === undefined ? 'none' : 'kept',
  })
  protected readonly words = computed(() => {
    const current = this.state()
    return current.status === 'shown' ? current.words : []
  })
  protected readonly total = computed(() => {
    const current = this.state()
    return (current.status === 'shown' ? current.qr.size : 0) + 2 * quietZone
  })
  // One square for each dark module, as a single path.
  protected readonly qrPath = computed(() => {
    const current = this.state()
    if (current.status !== 'shown') return ''
    const { size, modules } = current.qr
    const squares: string[] = []
    modules.forEach((dark, index) => {
      if (dark) squares.push(`M${(index % size) + quietZone} ${Math.floor(index / size) + quietZone}h1v1h-1z`)
    })
    return squares.join('')
  })
  private readonly makeKey = inject(RECOVERY_KEY_MAKER)

  protected async create(): Promise<void> {
    this.state.set({ status: 'creating' })
    try {
      this.state.set({ status: 'shown', ...(await this.makeKey()) })
    } catch {
      this.state.set({ status: 'failed' })
    }
  }

  protected keep(): void {
    const current = this.state()
    if (current.status !== 'shown') return
    // Either way, the words and the QR code leave the state.
    this.state.set({ status: keepRecoveryPublicKey(current.publicKey) ? 'kept' : 'failed' })
  }
}
