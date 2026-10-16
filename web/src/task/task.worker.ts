import init from '../lyre-wasm/lyre_wasm.js'
import { Backend } from '../separation/backend'
import { realSongMedia } from './song-media'
import { realSongModels } from './song-models'
import { songStages, SongTaskInput } from './song-task'
import { runTask, Stage, TaskReport, TaskStart } from './task'
import { testStages } from './test-stages'
import { opfsWorkingAreas } from './working-area'

// The song file and its access file are handed over to the page, not copied,
// so the worker keeps none.
const report = (message: TaskReport) =>
  postMessage(
    message,
    message.type === 'done' && message.song !== undefined && message.accessFile !== undefined
      ? [message.song.buffer, message.accessFile.buffer]
      : [],
  )

// Runs a task off the page's main thread, so the page stays responsive while
// a stage keeps the CPU busy. The page cancels a task by ending this worker.
addEventListener('message', (event: MessageEvent<TaskStart>) => {
  if (event.data.type !== 'start') return
  const { taskId, baseUri, song, backend } = event.data
  void stagesFor(song, baseUri, backend).then(
    (stages) => runTask({ taskId, stages, areas: opfsWorkingAreas(), report }),
    // The core could not load, so no stage ran and no working area was made.
    () => report({ type: 'failed', stage: '', reason: 'unexpected' }),
  )
})

async function stagesFor(
  song: SongTaskInput | undefined,
  baseUri: string | undefined,
  backend: Backend | undefined,
): Promise<Stage[]> {
  if (song === undefined) return testStages()
  if (baseUri === undefined) throw new Error('A song task needs the base URI.')
  // The build copies the core's module to lyre-wasm/, next to the page.
  await init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', baseUri) })
  return songStages(song, realSongMedia(), realSongModels(baseUri, backend ?? 'webgpu'))
}
