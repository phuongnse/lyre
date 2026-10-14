import { AlignerCheckReply, AlignerCheckRequest } from '../alignment/aligner-check-messages'
import { TestAligner } from '../alignment/aligner-session'
import { Backend } from '../separation/backend'
import { trustedScriptUrl } from '../worker-url'
import { Models } from './models'

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles aligner-check.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('../alignment/aligner-check.worker', import.meta.url), { type: 'module' })
}

// Each test aligner's model and vocabulary files (docs/reference/models.md).
const files: Record<TestAligner, { graph: string; vocabulary: string }> = {
  omnilingual: { graph: 'test-omnilingual-model', vocabulary: 'test-omnilingual-tokens' },
  'lyric-alignment': { graph: 'test-lyric-alignment-model', vocabulary: 'test-lyric-alignment-vocab' },
}

// Checks the test aligner's two files, then times the syllables of `lyrics`
// on the test audio in a Web Worker. Only the checked bytes reach the worker.
// `onProgress` gets each progress reply, and the promise the final one. The
// worker ends once it answers.
export async function runAlignerCheck(
  models: Models,
  aligner: TestAligner,
  lyrics: File,
  forced: Backend | undefined,
  onProgress: (progress: Extract<AlignerCheckReply, { type: 'progress' }>) => void,
): Promise<AlignerCheckReply> {
  let graph: Blob
  let vocabulary: Blob
  try {
    graph = await models.load(files[aligner].graph)
    vocabulary = await models.load(files[aligner].vocabulary)
  } catch {
    // A file that failed its check or could not be downloaded is not run.
    return { type: 'failed', problem: 'other' }
  }
  const worker = startWorker()
  try {
    return await new Promise<AlignerCheckReply>((resolve) => {
      worker.onmessage = ({ data }: MessageEvent<AlignerCheckReply>) => {
        if (data.type === 'progress') onProgress(data)
        else resolve(data)
      }
      worker.onerror = () => resolve({ type: 'failed', problem: 'other' })
      const request: AlignerCheckRequest = {
        type: 'run',
        aligner,
        graph,
        vocabulary,
        lyrics,
        baseUri: document.baseURI,
        forced,
      }
      worker.postMessage(request)
    })
  } finally {
    worker.terminate()
  }
}
