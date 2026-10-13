import { Backend } from '../separation/backend'
import { SeparationReply, SeparationRequest } from '../separation/separation-messages'
import { trustedScriptUrl } from '../worker-url'
import { Models } from './models'

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles separation.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('../separation/separation.worker', import.meta.url), { type: 'module' })
}

// A separation run in a Web Worker. Stopping it ends the worker, and the
// answer is then a failure.
export interface SeparationRun {
  reply: Promise<SeparationReply>
  stop(): void
}

// Checks the separator's two files, then separates the audio of `source` in a
// Web Worker. Only the checked bytes reach the worker. `test` picks the test
// separator instead of htdemucs. `onProgress` gets each progress reply, and
// `reply` the final one. The worker ends once it answers.
export function runSeparation(
  models: Models,
  source: File,
  options: { test: boolean; forced?: Backend },
  onProgress: (progress: Extract<SeparationReply, { type: 'progress' }>) => void,
): SeparationRun {
  let worker: globalThis.Worker | undefined
  let stopped = false
  let answer: (reply: SeparationReply) => void = () => undefined
  const reply = new Promise<SeparationReply>((resolve) => {
    answer = (data) => {
      stopped = true
      worker?.terminate()
      resolve(data)
    }
  })
  void (async () => {
    const prefix = options.test ? 'test-htdemucs' : 'htdemucs'
    let graph: Blob
    let weights: Blob
    try {
      graph = await models.load(`${prefix}-graph`)
      weights = await models.load(`${prefix}-weights`)
    } catch {
      // A file that failed its check or could not be downloaded is not run.
      answer({ type: 'failed', problem: 'model' })
      return
    }
    if (stopped) return
    worker = startWorker()
    worker.onmessage = ({ data }: MessageEvent<SeparationReply>) => {
      if (stopped) return
      if (data.type === 'progress') onProgress(data)
      else answer(data)
    }
    worker.onerror = () => answer({ type: 'failed', problem: 'unreadable' })
    const request: SeparationRequest = {
      type: 'run',
      source,
      graph,
      weights,
      baseUri: document.baseURI,
      forced: options.forced,
    }
    worker.postMessage(request)
  })()
  return { reply, stop: () => answer({ type: 'failed', problem: 'unreadable' }) }
}
