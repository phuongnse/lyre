import { alignerRunner } from '../alignment/aligner-session'
import { openSession, SessionCreator } from '../onnx-session'
import { Backend } from '../separation/backend'
import { openSeparator, separatorRunner } from '../separation/separator-session'
import { SongModels } from './song-task'

// The real model runs of a task's stages, for the task's worker only: ONNX
// Runtime Web. `baseUri` is the page's, which ONNX Runtime's WebAssembly file
// is fetched against. A task runs only on the backend it is given: its
// sessions are opened as in a measurement, so they never fall back to another
// one. A session that cannot open throws a SessionFault. `create` is for
// tests, which open no real session.
export function realSongModels(baseUri: string, backend: Backend, create?: SessionCreator): SongModels {
  const options = { baseUri, forced: backend, measuring: true, create }
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
