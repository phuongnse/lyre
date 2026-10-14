import init from '../lyre-wasm/lyre_wasm.js'
import { realSongMedia, realSongModels } from './song-media'
import { songStages, SongTaskInput } from './song-task'
import { runTask, Stage, TaskReport } from './task'
import { testStages } from './test-stages'
import { opfsWorkingAreas } from './working-area'

// What the page sends to start a task. Without `song`, the task runs the test
// stages, as the task check page does. With `song`, it makes a song file from
// it, and `baseUri` is the page's base URI to load the core and the models from.
export type TaskStart = { type: 'start'; taskId: string; baseUri?: string; song?: SongTaskInput }

// The song file is handed over to the page, not copied, so the worker keeps none.
const report = (message: TaskReport) =>
  postMessage(message, message.type === 'done' && message.song !== undefined ? [message.song.buffer] : [])

// Runs a task off the page's main thread, so the page stays responsive while
// a stage keeps the CPU busy. The page cancels a task by ending this worker.
addEventListener('message', (event: MessageEvent<TaskStart>) => {
  if (event.data.type !== 'start') return
  const { taskId, baseUri, song } = event.data
  void stagesFor(song, baseUri).then(
    (stages) => runTask({ taskId, stages, areas: opfsWorkingAreas(), report }),
    // The core could not load, so no stage ran and no working area was made.
    () => report({ type: 'failed', stage: '', reason: 'unexpected' }),
  )
})

async function stagesFor(song: SongTaskInput | undefined, baseUri: string | undefined): Promise<Stage[]> {
  if (song === undefined) return testStages()
  if (baseUri === undefined) throw new Error('A song task needs the base URI.')
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', baseUri) })
  return songStages(song, realSongMedia(), realSongModels(baseUri))
}
