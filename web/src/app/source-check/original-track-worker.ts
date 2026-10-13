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

// Sends `request` to a new original track worker. The worker ends once it
// answers.
function runInWorker(request: PackageRequest): Packaging {
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
  worker.postMessage(request)
  return { reply, stop: () => answer({ type: 'failed' }) }
}

// Packages the primary audio of `file` in a Web Worker.
export function packageInWorker(file: File, storedType: string): Packaging {
  return runInWorker({ type: 'package', file, storedType })
}

// Makes the thumbnail of `file`, a JPEG or none, in a Web Worker.
export function thumbnailInWorker(file: File): Packaging {
  return runInWorker({ type: 'thumbnail', file })
}

// Packages the primary audio of `file` into the original track, then makes
// the karaoke track from `karaokeFile` at its cut times, in a Web Worker.
// With `videoType`, it then packages the primary video of `file` too.
export function makeAudioInWorker(file: File, karaokeFile: File, storedType: string, videoType?: string): Packaging {
  return runInWorker({
    type: 'make-audio',
    file,
    karaokeFile,
    storedType,
    ...(videoType === undefined ? {} : { videoType }),
  })
}
