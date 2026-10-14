import { alignerRunner } from '../alignment/aligner-session'
import { makeKaraoke } from '../karaoke-track'
import { loadModel } from '../models/model-download'
import { opfsModelFiles } from '../models/model-files'
import { openSession } from '../onnx-session'
import { packageOriginal } from '../original-track'
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

// `baseUri` is the page's, which model files and ONNX Runtime's WebAssembly
// file are fetched against.
export function realSongModels(baseUri: string): SongModels {
  return {
    // A kept file that still passes its check is used. Otherwise the file is
    // downloaded and checked. A file that fails is never returned.
    load: (id) =>
      loadModel(id, {
        files: opfsModelFiles(),
        // Called through a function, because fetch needs the global as `this`.
        fetch: (input, init) => fetch(input, init),
        baseUri,
      }),
    async openSeparator(graph) {
      const { session } = await openSeparator(graph, { baseUri })
      return { run: separatorRunner(session), release: () => session.release() }
    },
    async openAligner(kind, graph) {
      const { session } = await openSession(graph, { baseUri })
      return { run: alignerRunner(session, kind), release: () => session.release() }
    },
  }
}
