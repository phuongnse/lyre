import { expect, test } from 'vitest'
import { SongRefusal, VideoRefusal } from '../../original-track-messages'
import { SourceDetails } from '../../source'
import { makeFailedMessage, makeSongFailedMessage, songDetailsFor, songFileName } from './source-check.component'

// Each video refusal gets its own message, and any other failure the general one.
test.each<[VideoRefusal | undefined, string]>([
  ['keyframe gap', "This source's keyframes are more than 20 s apart, so a song cannot be made from it."],
  ['group too large', 'This source has a group of video frames over 64 MiB, so a song cannot be made from it.'],
  [undefined, 'The tracks could not be made for a song.'],
])('a failure with reason %s shows its message', (reason, message) => {
  expect(makeFailedMessage(reason)).toBe(message)
})

// Each refusal a user can fix gets its own message, and any other failure the general one.
test.each<[VideoRefusal | SongRefusal | undefined, string]>([
  ['lyrics', 'The lyrics file is not valid lyrics.'],
  ['timing-file', 'The timing file does not match the lyrics.'],
  ['past-end', 'The timing ends after the song, so the song file was not made.'],
  ['keyframe gap', "This source's keyframes are more than 20 s apart, so a song cannot be made from it."],
  ['group too large', 'This source has a group of video frames over 64 MiB, so a song cannot be made from it.'],
  [undefined, 'The song file could not be made.'],
])('a song file failure with reason %s shows its message', (reason, message) => {
  expect(makeSongFailedMessage(reason)).toBe(message)
})

const source: SourceDetails = { duration: 2, startOffset: 0, hasVideo: true }
// A decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
const artist = 'Hà  Nội'

test('the song details take the title tag when there is one', () => {
  const details = songDetailsFor({ ...source, title: 'Mưa rơi nhẹ', artist, composer: 'Lê' }, 'song.webm', 'male')
  expect(details).toEqual({ title: 'Mưa rơi nhẹ', artist, composer: 'Lê', vocalRole: 'male' })
})

test('without a title tag, the title is the file name without its extension', () => {
  expect(songDetailsFor(source, 'song.webm', 'female').title).toBe('song')
  expect(songDetailsFor(source, 'my.song.mp3', 'female').title).toBe('my.song')
  expect(songDetailsFor(source, 'song', 'female').title).toBe('song')
})

test('the song details keep the artist byte for byte, and a missing composer is empty', () => {
  const details = songDetailsFor({ ...source, artist }, 'song.webm', 'female')
  expect(Buffer.from(details.artist).toString('hex')).toBe(Buffer.from(artist).toString('hex'))
  expect(details.composer).toBe('')
  expect(details.vocalRole).toBe('female')
})

test('the song file downloads under the source file name with .lyre in place of its extension', () => {
  expect(songFileName('song.webm')).toBe('song.lyre')
  expect(songFileName('my.song.mp3')).toBe('my.song.lyre')
  expect(songFileName('song')).toBe('song.lyre')
})
