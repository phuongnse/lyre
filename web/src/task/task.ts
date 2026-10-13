import { WorkingArea, WorkingAreas } from './working-area'

// A task: one run of processing for one song (docs/domain/concepts.md). It
// runs its stages one after another and reports the stage it is in and its
// progress. This file has no DOM or worker dependency, so tests run it as is.

// Why a task stopped. The page shows a message for each.
export type TaskFailure = 'test-stage-failed' | 'another-task-running' | 'unexpected'

// What a stage throws to stop the task with a reason the page can show.
export class StageFailure extends Error {
  constructor(readonly reason: TaskFailure) {
    super(reason)
  }
}

export interface StageContext {
  // The task's working area. A stage writes nowhere else.
  area: WorkingArea
  // Reports the fraction of the stage done, from 0 to 1.
  progress(fraction: number): void
}

export interface Stage {
  readonly name: string
  run(context: StageContext): Promise<void>
}

// `index` counts from 0. A report without `fraction` says the stage has started.
export type ProgressReport = {
  type: 'progress'
  stage: string
  index: number
  count: number
  fraction?: number
  timeLeftMs?: number
}

export type TaskReport = ProgressReport | { type: 'done' } | { type: 'failed'; stage: string; reason: TaskFailure }

// How long a stage runs before its time left is measured. Before that, or
// before any progress, an estimate would be a guess.
export const MEASURE_AFTER_MS = 1000

// The time left in the current stage, from how long it has run and the
// fraction it has done. Later stages are not counted: how long they take is
// unknown until they run.
export function timeLeft(elapsedMs: number, fraction: number): number | undefined {
  if (!(fraction > 0) || elapsedMs < MEASURE_AFTER_MS) return undefined
  return (elapsedMs * (1 - fraction)) / fraction
}

// Runs `stages` in order in the working area of `taskId`. The area is removed
// when the task ends, whether it is done or failed. Nothing hands over a song
// yet: the stage that writes the song file comes later.
export async function runTask(o: {
  taskId: string
  stages: readonly Stage[]
  areas: WorkingAreas
  report(report: TaskReport): void
  now?: () => number
}): Promise<void> {
  const now = o.now ?? (() => performance.now())
  const count = o.stages.length
  let stage = ''
  try {
    const area = await o.areas.create(o.taskId)
    for (const [index, current] of o.stages.entries()) {
      stage = current.name
      const start = now()
      o.report({ type: 'progress', stage, index, count })
      await current.run({
        area,
        progress(fraction) {
          const clamped = Math.min(1, Math.max(0, fraction))
          const report: ProgressReport = { type: 'progress', stage: current.name, index, count, fraction: clamped }
          const left = timeLeft(now() - start, clamped)
          if (left !== undefined) report.timeLeftMs = left
          o.report(report)
        },
      })
    }
  } catch (error) {
    const reason = error instanceof StageFailure ? error.reason : 'unexpected'
    await o.areas.remove(o.taskId).catch(() => {})
    o.report({ type: 'failed', stage, reason })
    return
  }
  await o.areas.remove(o.taskId).catch(() => {})
  o.report({ type: 'done' })
}
