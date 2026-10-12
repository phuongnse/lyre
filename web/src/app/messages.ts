// Every user-visible string lives here (docs/ui-conventions.md#strings).
// The text is still English. The Vietnamese text comes in a later issue.
export const messages = {
  appTitle: 'Lyre',
  coreLoading: 'Loading the Lyre core…',
  coreVersion: (version: string) => `Lyre core ${version}`,
  coreFailed: 'Could not load the Lyre core.',
  openSongFile: 'Open a song file',
  songFileOpening: 'Opening the song file…',
  songFileNotASongFile: 'This file is not a song file.',
  songFileDamaged: 'This song file is damaged or incomplete.',
  play: 'Play',
  pause: 'Pause',
  songVideo: 'Song video',
  library: 'Library',
  songArtist: (name: string) => `Artist: ${name}`,
  songComposer: (name: string) => `Composer: ${name}`,
  libraryMayBeCleared: 'Your browser did not allow lasting storage, so it may clear these songs.',
  audioTrack: 'Track',
  karaoke: 'Karaoke',
  original: 'Original',
} as const
