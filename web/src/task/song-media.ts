import { makeKaraoke } from '../karaoke-track'
import { packageOriginal } from '../original-track'
import { readSource } from '../source'
import { decodeAudio } from '../source-audio'
import { makeThumbnail } from '../thumbnail'
import { packageVideo } from '../video-track'
import { SongMedia } from './song-task'

// The real media work of a task's stages, for the task's worker only:
// Mediabunny through WebCodecs.

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
