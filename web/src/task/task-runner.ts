import { Injectable, inject, signal } from '@angular/core'
import { WORKING_AREAS } from '../app/working-areas'
import { Backend } from '../separation/backend'
import { trustedScriptUrl } from '../worker-url'
import { SongTaskInput } from './song-task'
import { ProgressReport, TaskFailure, TaskReport, TaskStart, UnknownSyllable } from './task'
import { TASK_LOCK } from './working-area'

// The song a task makes, and the backend its models run on.
export interface SongRun {
  input: SongTaskInput
  backend?: Backend
}

export type TaskState =
  | { status: 'idle' }
  | { status: 'running'; report?: ProgressReport }
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; stage?: string; reason: TaskFailure; unknown?: UnknownSyllable }

// How far the current stage is, from 0 to 100.
export function stagePercent(state: TaskState): number {
  if (state.status === 'done') return 100
  return state.status === 'running' ? (state.report?.fraction ?? 0) * 100 : 0
}

// The seconds left in the current stage, once it has the figure.
export function secondsLeft(state: TaskState): number | undefined {
  const left = state.status === 'running' ? state.report?.timeLeftMs : undefined
  return left === undefined ? undefined : Math.max(1, Math.ceil(left / 1000))
}

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

  // Whether a task in another tab, or the startup cleanup there, holds the task lock.
  async anotherTaskRunning(): Promise<boolean> {
    if (!navigator.locks) return false
    const { held } = await navigator.locks.query()
    return held?.some((lock) => lock.name === TASK_LOCK) ?? false
  }

  // Without `song`, the task runs the test stages. With it, the task makes
  // that song, on `backend`, WebGPU when none is given.
  start(song?: SongRun): void {
    if (this.current().status === 'running') return
    this.current.set({ status: 'running' })
    navigator.locks
      .request(TASK_LOCK, { ifAvailable: true }, (lock) =>
        lock === null ? this.current.set({ status: 'failed', reason: 'another-task-running' }) : this.run(song),
      )
      .catch(() => this.current.set({ status: 'failed', reason: 'unexpected' }))
  }

  // Ends the worker at once, because a model run cannot stop partway through
  // when asked. Then removes the working area.
  async cancel(): Promise<void> {
    await this.cancelTask?.()
  }

  // Resolves when the task has ended and its working area is removed, which releases the lock.
  private run(song?: SongRun): Promise<void> {
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
        else {
          const failed: TaskState = { status: 'failed', stage: data.stage, reason: data.reason }
          if (data.unknown !== undefined) failed.unknown = data.unknown
          void end(failed)
        }
      }
      worker.onerror = () => void end({ status: 'failed', reason: 'unexpected' })
      const start: TaskStart =
        song === undefined
          ? { type: 'start', taskId }
          : { type: 'start', taskId, baseUri: document.baseURI, song: song.input, backend: song.backend }
      worker.postMessage(start)
    })
  }
}
