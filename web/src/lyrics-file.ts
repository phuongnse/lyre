import { isValidLyrics } from './lyre-wasm/lyre_wasm.js'

// Whether the file holds valid lyrics, as the core reads them. The file is
// only read, never changed, and its text is never kept (D5). The core must be
// loaded first, as with `readSource`. A file that cannot be read is not valid
// lyrics.
export async function lyricsAreValid(file: Blob): Promise<boolean> {
  try {
    return isValidLyrics(new Uint8Array(await file.arrayBuffer()))
  } catch {
    return false
  }
}
