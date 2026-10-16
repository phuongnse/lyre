import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { messages } from './messages'
import { keepRecoveryPublicKey, NewRecovery, RECOVERY_KEY_MAKER, readRecoveryPublicKey } from './recovery-key'

// What the page shows of a new key. The QR code is already drawn as a path, so
// no signal or cache outside `state` holds the words or the code.
type Shown = { status: 'shown'; words: string[]; total: number; qrPath: string; publicKey: Uint8Array }

type State =
  | { status: 'none' }
  | { status: 'creating' }
  | Shown
  | { status: 'kept' }
  | { status: 'superseded' }
  | { status: 'failed' }

// The blank border around a QR code, in modules. The reference sets it.
const quietZone = 4
// How many pixels a module takes on screen.
const modulePixels = 5

// The Recovery key section (docs/ui-conventions.md#recovery-key). The owner
// makes the key, sees its words and QR code once, and confirms they kept it.
// Only then does the page keep the public part. The words and the QR code live
// only in the `state` signal while they are shown, and leave it when the state
// changes. Nothing is logged, and no error's text is shown.
@Component({
  selector: 'lyre-recovery-key',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:storage)': 'onStorage()' },
  template: `
    <section aria-labelledby="recovery-key-heading">
      <h2 id="recovery-key-heading">{{ messages.recoveryKey }}</h2>
      @let current = state();
      @if (current.status === 'kept' || current.status === 'superseded') {
        @if (current.status === 'superseded') {
          <p role="alert">{{ messages.recoveryKeyOtherTab }}</p>
        }
        <p>{{ messages.recoveryKeyKept }}</p>
      } @else if (current.status === 'shown') {
        <ol [attr.aria-label]="messages.recoveryWords">
          @for (word of current.words; track $index) {
            <li>{{ word }}</li>
          }
        </ol>
        <!-- The QR code is black on white in every theme: a scanner cannot read light cells on a dark ground. -->
        <svg
          role="img"
          [attr.aria-label]="messages.recoveryKeyQr"
          [attr.viewBox]="'0 0 ' + current.total + ' ' + current.total"
          [attr.width]="current.total * modulePixels"
          [attr.height]="current.total * modulePixels"
          shape-rendering="crispEdges"
        >
          <rect width="100%" height="100%" fill="#fff" />
          <path [attr.d]="current.qrPath" fill="#000" />
        </svg>
        <p>{{ messages.recoveryKeyKeepOffline }}</p>
        <button matButton="filled" type="button" (click)="keep()">{{ messages.keptRecoveryKey }}</button>
      } @else {
        <p>{{ messages.recoveryKeyAbout }}</p>
        @if (current.status === 'failed') {
          <p role="alert">{{ messages.recoveryKeyFailed }}</p>
        }
        <button matButton="filled" type="button" [disabled]="current.status === 'creating'" (click)="create()">
          {{ messages.createRecoveryKey }}
        </button>
        <p role="status">{{ current.status === 'creating' ? messages.recoveryKeyCreating : '' }}</p>
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
  private readonly makeKey = inject(RECOVERY_KEY_MAKER)

  protected async create(): Promise<void> {
    this.state.set({ status: 'creating' })
    try {
      const made = await this.makeKey()
      // A key another tab kept while this one was making theirs wins.
      this.state.set(readRecoveryPublicKey() === undefined ? shownOf(made) : { status: 'kept' })
    } catch {
      this.state.set({ status: 'failed' })
    }
  }

  protected keep(): void {
    const current = this.state()
    if (current.status !== 'shown') return
    // Whatever the result, the words and the QR code leave the state.
    const result = keepRecoveryPublicKey(current.publicKey)
    this.state.set({ status: result === 'exists' ? 'superseded' : result })
  }

  // Another tab kept a key. This tab never replaces it: it drops the words it
  // shows, and tells the owner when they were looking at them.
  protected onStorage(): void {
    const current = this.state()
    if (current.status === 'kept' || current.status === 'superseded' || readRecoveryPublicKey() === undefined) return
    this.state.set({ status: current.status === 'shown' ? 'superseded' : 'kept' })
  }
}

// One square for each dark module, as a single path.
function shownOf(made: NewRecovery): Shown {
  const { size, modules } = made.qr
  const squares: string[] = []
  modules.forEach((dark, index) => {
    if (dark) squares.push(`M${(index % size) + quietZone} ${Math.floor(index / size) + quietZone}h1v1h-1z`)
  })
  return {
    status: 'shown',
    words: made.words,
    total: size + 2 * quietZone,
    qrPath: squares.join(''),
    publicKey: made.publicKey,
  }
}
