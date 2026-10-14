import { Backend } from '../separation/backend'
import { SeparatorCheckReply, SeparatorCheckRequest } from '../separation/check-messages'
import { trustedScriptUrl } from '../worker-url'
import { Models } from './models'

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles separator-check.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('../separation/separator-check.worker', import.meta.url), { type: 'module' })
}

// Checks the test separator's file, then runs one segment of the test
// separator in a Web Worker. Only the checked bytes reach the worker. It
// throws when a file fails its check or cannot be downloaded.
export async function runSeparatorCheck(models: Models, forced?: Backend): Promise<SeparatorCheckReply> {
  const separator = await models.load('test-mel-roformer')
  const worker = startWorker()
  try {
    return await new Promise<SeparatorCheckReply>((resolve) => {
      worker.onmessage = ({ data }: MessageEvent<SeparatorCheckReply>) => resolve(data)
      worker.onerror = () => resolve({ type: 'failed' })
      const request: SeparatorCheckRequest = { type: 'run', separator, baseUri: document.baseURI, forced }
      worker.postMessage(request)
    })
  } finally {
    worker.terminate()
  }
}
