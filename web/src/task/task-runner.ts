import { Injectable, inject, signal } from '@angular/core'
import { WORKING_AREAS } from '../app/working-areas'
import { trustedScriptUrl } from '../worker-url'
import { ProgressReport, TaskFailure, TaskReport } from './task'
import { TASK_LOCK } from './working-area'

export type TaskState =
  | { status: 'idle' }
  | { status: 'running'; report?: ProgressReport }
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; stage?: string; reason: TaskFailure }

function startWorker(): globalThis.Worker {
  // Named Worker, so Angular's builder still finds the call below and bundles task.worker.ts.
  class Worker extends globalThis.Worker {
    constructor(url: URL, options: WorkerOptions) {
      super(trustedScriptUrl(url), options)
    }
  }
  return new Worker(new URL('./task.worker', import.meta.url), { type: 'module' })
}

// Runs one task at a time in a Web Worker and keeps its state for the page
// (docs/architecture.md#processing). It holds the task lock for the whole run,
// so a task in another tab, or the startup cleanup there, waits for it.
@Injectable({ providedIn: 'root' })
export class TaskRunner {
  private readonly areas = inject(WORKING_AREAS)
  private readonly current = signal<TaskState>({ status: 'idle' })
  private cancelTask?: () => Promise<void>
  readonly state = this.current.asReadonly()

  start(): void {
    if (this.current().status === 'running') return
    this.current.set({ status: 'running' })
    navigator.locks
      .request(TASK_LOCK, { ifAvailable: true }, (lock) =>
        lock === null ? this.current.set({ status: 'failed', reason: 'another-task-running' }) : this.run(),
      )
      .catch(() => this.current.set({ status: 'failed', reason: 'unexpected' }))
  }

  // Ends the worker at once, because a model run cannot stop partway through
  // when asked. Then removes the working area.
  async cancel(): Promise<void> {
    await this.cancelTask?.()
  }

  // Resolves when the task has ended and its working area is removed, which releases the lock.
  private run(): Promise<void> {
    const taskId = crypto.randomUUID()
    const worker = startWorker()
    return new Promise((resolve) => {
      let ended = false
      // The worker removes the area itself when it is done or failed. Removing
      // it again here also covers a worker that was ended or crashed.
      const end = async (state: TaskState) => {
        if (ended) return
        ended = true
        this.cancelTask = undefined
        worker.terminate()
        await this.areas.remove(taskId).catch(() => {})
        this.current.set(state)
        resolve()
      }
      this.cancelTask = () => end({ status: 'cancelled' })
      worker.onmessage = ({ data }: MessageEvent<TaskReport>) => {
        if (ended) return
        if (data.type === 'progress') this.current.set({ status: 'running', report: data })
        else if (data.type === 'done') void end({ status: 'done' })
        else void end({ status: 'failed', stage: data.stage, reason: data.reason })
      }
      worker.onerror = () => void end({ status: 'failed', reason: 'unexpected' })
      worker.postMessage({ type: 'start', taskId })
    })
  }
}
