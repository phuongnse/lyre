import { Stage, StageContext } from './task'

const STEPS = 20
const STEP_MS = 100
const FILE_BYTES = 1024

// Stands in for a real stage on the task check page. Each step keeps the CPU
// busy, as a model run does, then writes a small file to the working area.
function testStage(name: string): Stage {
  return {
    name,
    async run({ area, progress }: StageContext) {
      for (let step = 0; step < STEPS; step++) {
        const end = performance.now() + STEP_MS
        while (performance.now() < end) {
          // Busy on purpose.
        }
        await area.write(`${name}-${step}.bin`, new Uint8Array(FILE_BYTES))
        progress((step + 1) / STEPS)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
  }
}

// Three test stages of about 2 s each, so a check has a stage to interrupt.
export function testStages(): Stage[] {
  return ['test-1', 'test-2', 'test-3'].map(testStage)
}
