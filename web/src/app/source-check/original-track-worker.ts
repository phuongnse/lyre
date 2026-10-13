import { PackageReply, PackageRequest } from '../../original-track-messages'
import { trustedScriptUrl } from '../../worker-url'

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles original-track.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('../../original-track.worker', import.meta.url), { type: 'module' })
}

// A run of the original track worker on one source. Stopping it ends the
// worker, and the answer is then a failure.
export interface Packaging {
  reply: Promise<PackageReply>
  stop(): void
}

// Packages the primary audio of `file` in a Web Worker. The worker ends once
// it answers.
export function packageInWorker(file: File, storedType: string): Packaging {
  const worker = startWorker()
  let answer: (reply: PackageReply) => void = () => undefined
  const reply = new Promise<PackageReply>((resolve) => {
    answer = (data) => {
      worker.terminate()
      resolve(data)
    }
  })
  worker.onmessage = ({ data }: MessageEvent<PackageReply>) => answer(data)
  worker.onerror = () => answer({ type: 'failed' })
  const request: PackageRequest = { type: 'package', file, storedType }
  worker.postMessage(request)
  return { reply, stop: () => answer({ type: 'failed' }) }
}
