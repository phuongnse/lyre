import type { SongDetailsInput, VocalRole } from '../original-track-messages'
import type { SourceDetails } from '../source'

// The last extension of a file name, such as ".webm".
const EXTENSION = /\.[^.]*$/

// The title, artist and composer a song starts with, from the source's tags,
// exactly as stored. Without a title tag, the title is the source's file name
// without its extension. A missing artist or composer is empty, which means
// not known.
export function detailsFromTags(
  details: SourceDetails,
  fileName: string,
): { title: string; artist: string; composer: string } {
  return {
    title: details.title ?? fileName.replace(EXTENSION, ''),
    artist: details.artist ?? '',
    composer: details.composer ?? '',
  }
}

// The song's details from the source's tags and the vocal role.
export function songDetailsFor(details: SourceDetails, fileName: string, vocalRole: VocalRole): SongDetailsInput {
  return { ...detailsFromTags(details, fileName), vocalRole }
}

// The name a song file made from the source `fileName` downloads as.
export function songFileName(fileName: string): string {
  return `${fileName.replace(EXTENSION, '')}.lyre`
}
