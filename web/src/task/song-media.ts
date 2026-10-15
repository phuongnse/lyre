import { alignerRunner } from '../alignment/aligner-session'
import { makeKaraoke } from '../karaoke-track'
import { openSession } from '../onnx-session'
import { packageOriginal } from '../original-track'
import { Backend } from '../separation/backend'
import { openSeparator, separatorRunner } from '../separation/separator-session'
import { readSource } from '../source'
import { decodeAudio } from '../source-audio'
import { makeThumbnail } from '../thumbnail'
import { packageVideo } from '../video-track'
import { SongMedia, SongModels } from './song-task'

// The real media work and model runs of a task's stages, for the task's
// worker only: Mediabunny through WebCodecs, and ONNX Runtime Web.

export function realSongMedia(): SongMedia {
  return {
    readSource: (file) => readSource(file),
    decode: decodeAudio,
    packageOriginal,
    makeKaraoke,
    packageVideo,
    makeThumbnail,
  }
}

// `baseUri` is the page's, which ONNX Runtime's WebAssembly file is fetched
// against. A task runs only on the backend it is given: its sessions are
// opened as in a measurement, so they never fall back to another one.
export function realSongModels(baseUri: string, backend: Backend): SongModels {
  const options = { baseUri, forced: backend, measuring: true }
  return {
    async openSeparator(graph) {
      const { session } = await openSeparator(graph, options)
      return { run: separatorRunner(session), release: () => session.release() }
    },
    async openAligner(kind, graph) {
      const { session } = await openSession(graph, options)
      return { run: alignerRunner(session, kind), release: () => session.release() }
    },
  }
}
