import { MeasurementReply, MeasurementRequest } from '../measurement/measurement-messages'
import { trustedScriptUrl } from '../worker-url'

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles measurement.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('../measurement/measurement.worker', import.meta.url), { type: 'module' })
}

// A measurement run in a Web Worker. Stopping it ends the worker.
export interface MeasurementRun {
  done: Promise<void>
  stop(): void
}

// Measures the candidates of `request` in a Web Worker. Only the checked
// bytes the page loaded reach the worker. `onReply` gets every reply in
// order. `done` settles once the run ends, with 'done', a failed sum check or
// a failure, and the worker then ends. Nothing is answered after a stop.
export function runMeasurement(
  request: MeasurementRequest,
  onReply: (reply: MeasurementReply) => void,
): MeasurementRun {
  const worker = startWorker()
  let finish: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    finish = () => {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      resolve()
    }
  })
  worker.onmessage = ({ data }: MessageEvent<MeasurementReply>) => {
    onReply(data)
    if (data.type === 'done' || data.type === 'failed' || data.type === 'sum-check-failed') finish()
  }
  worker.onerror = () => {
    onReply({ type: 'failed', problem: 'unreadable' })
    finish()
  }
  worker.postMessage(request)
  return { done, stop: finish }
}
