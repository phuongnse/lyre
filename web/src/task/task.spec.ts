import { describe, expect, test } from 'vitest'
import { FakeWorkingAreas } from './fake-working-areas'
import { runTask, Stage, StageContext, StageFailure, TaskReport, timeLeft } from './task'

const taskId = 'task-1'

// A stage that records its name in `ran`, writes one file and then does `then`.
function stage(name: string, ran: string[], then: (context: StageContext) => void = () => {}): Stage {
  return {
    name,
    async run(context) {
      ran.push(name)
      await context.area.write(`${name}.bin`, new Uint8Array(4))
      then(context)
    },
  }
}

async function run(stages: Stage[], now?: () => number): Promise<{ reports: TaskReport[]; areas: FakeWorkingAreas }> {
  const reports: TaskReport[] = []
  const areas = new FakeWorkingAreas()
  await runTask({ taskId, stages, areas, report: (report) => reports.push(report), now })
  return { reports, areas }
}

describe('runTask', () => {
  test('runs the stages in order, reports each in turn and then done, and removes the working area', async () => {
    const ran: string[] = []
    const written: number[] = []
    const areas = new FakeWorkingAreas()
    const reports: TaskReport[] = []
    const stages = ['a', 'b', 'c'].map((name) =>
      stage(name, ran, () => written.push(areas.areas.get(taskId)?.size ?? 0)),
    )
    await runTask({ taskId, stages, areas, report: (report) => reports.push(report) })

    expect(ran).toEqual(['a', 'b', 'c'])
    // Each stage wrote its file in the task's own working area.
    expect(written).toEqual([1, 2, 3])
    expect(reports).toEqual([
      { type: 'progress', stage: 'a', index: 0, count: 3 },
      { type: 'progress', stage: 'b', index: 1, count: 3 },
      { type: 'progress', stage: 'c', index: 2, count: 3 },
      { type: 'done' },
    ])
    expect(areas.areas.has(taskId)).toBe(false)
  })

  test('stops at a stage failure with its reason, removes the working area and runs no later stage', async () => {
    const ran: string[] = []
    const stages = [
      stage('a', ran),
      stage('b', ran, () => {
        throw new StageFailure('test-stage-failed')
      }),
      stage('c', ran),
    ]
    const { reports, areas } = await run(stages)

    expect(ran).toEqual(['a', 'b'])
    expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'b', reason: 'test-stage-failed' })
    expect(reports.some((report) => report.type === 'done')).toBe(false)
    expect(areas.areas.has(taskId)).toBe(false)
  })

  test('reports any other error as unexpected', async () => {
    const ran: string[] = []
    const { reports, areas } = await run([
      stage('a', ran, () => {
        throw new Error('details')
      }),
    ])
    expect(reports.at(-1)).toEqual({ type: 'failed', stage: 'a', reason: 'unexpected' })
    expect(areas.areas.has(taskId)).toBe(false)
  })

  test('gives no time left until the stage has run 1 s and reported progress', async () => {
    let time = 0
    const steps: [number, number][] = [
      [500, 0.5],
      [999, 0.9],
      [1000, 0.5],
      [2000, 0],
      [3000, 0.75],
    ]
    const timed: Stage = {
      name: 'a',
      async run({ progress }) {
        for (const [at, fraction] of steps) {
          time = at
          progress(fraction)
        }
      },
    }
    const { reports } = await run([timed], () => time)

    const progress = reports.filter((report) => report.type === 'progress')
    expect(progress.map(({ fraction, timeLeftMs }) => ({ fraction, timeLeftMs }))).toEqual([
      { fraction: undefined, timeLeftMs: undefined },
      { fraction: 0.5, timeLeftMs: undefined },
      { fraction: 0.9, timeLeftMs: undefined },
      { fraction: 0.5, timeLeftMs: 1000 },
      { fraction: 0, timeLeftMs: undefined },
      { fraction: 0.75, timeLeftMs: 1000 },
    ])
  })

  test('measures the time left from the start of the current stage', async () => {
    let time = 0
    const timed = (name: string): Stage => ({
      name,
      async run({ progress }) {
        time += 2000
        progress(0.5)
      },
    })
    const { reports } = await run([timed('a'), timed('b')], () => time)
    const left = reports.flatMap((report) => (report.type === 'progress' && report.fraction ? [report.timeLeftMs] : []))
    expect(left).toEqual([2000, 2000])
  })

  test('clamps the fraction a stage reports to 0..1', async () => {
    const { reports } = await run([
      {
        name: 'a',
        async run({ progress }) {
          progress(-1)
          progress(2)
        },
      },
    ])
    const fractions = reports.flatMap((report) => (report.type === 'progress' ? [report.fraction] : []))
    expect(fractions).toEqual([undefined, 0, 1])
  })
})

describe('timeLeft', () => {
  test.each<[number, number, number | undefined]>([
    [0, 0.5, undefined],
    [999, 0.5, undefined],
    [1000, 0, undefined],
    [1000, 0.5, 1000],
    [1000, 0.25, 3000],
    [4000, 1, 0],
  ])('after %i ms at %f gives %s', (elapsedMs, fraction, expected) => {
    expect(timeLeft(elapsedMs, fraction)).toBe(expected)
  })
})
