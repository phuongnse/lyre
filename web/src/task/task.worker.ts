import { runTask } from './task'
import { testStages } from './test-stages'
import { opfsWorkingAreas } from './working-area'

// Runs a task off the page's main thread, so the page stays responsive while
// a stage keeps the CPU busy. The page cancels a task by ending this worker.
addEventListener('message', (event: MessageEvent<{ type: 'start'; taskId: string }>) => {
  if (event.data.type !== 'start') return
  void runTask({
    taskId: event.data.taskId,
    stages: testStages(),
    areas: opfsWorkingAreas(),
    report: (report) => postMessage(report),
  })
})
