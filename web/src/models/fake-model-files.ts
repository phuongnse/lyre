import { ModelFiles, ModelWriter } from './model-files'

// In-memory model files for tests. `granted` is what the browser answers about
// persistent storage. It records every piece written, every removal and every
// call, in order.
export class FakeModelFiles implements ModelFiles {
  readonly files = new Map<string, Blob>()
  readonly pieces: Uint8Array[] = []
  readonly removed: string[] = []
  readonly calls: string[] = []

  constructor(private readonly granted = true) {}

  async get(id: string): Promise<Blob | undefined> {
    this.calls.push(`get ${id}`)
    return this.files.get(id)
  }

  async create(id: string): Promise<ModelWriter> {
    this.calls.push(`create ${id}`)
    const written: Uint8Array[] = []
    return {
      write: async (piece) => {
        // A copy, so a reader reusing its buffer cannot change what was written.
        const copy = piece.slice()
        written.push(copy)
        this.pieces.push(copy)
      },
      commit: async () => {
        this.calls.push(`commit ${id}`)
        // Joining the pieces happens only here, in the fake, so a test can check them.
        this.files.set(id, new Blob(written as Uint8Array<ArrayBuffer>[]))
      },
      abort: async () => {
        this.calls.push(`abort ${id}`)
      },
    }
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id}`)
    this.removed.push(id)
    this.files.delete(id)
  }

  async persisted(): Promise<boolean> {
    this.calls.push('persisted')
    return this.granted
  }

  async persist(): Promise<boolean> {
    this.calls.push('persist')
    return this.granted
  }
}
