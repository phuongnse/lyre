import { expect, test } from 'vitest'
import { SourceDetails } from '../source'
import { detailsFromTags, songDetailsFor, songFileName } from './song-details'

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

test('the details fields start from the tags exactly, and the title falls back to the file name', () => {
  expect(detailsFromTags({ ...source, title: 'Mưa rơi nhẹ', artist, composer: 'Lê' }, 'song.mp3')).toEqual({
    title: 'Mưa rơi nhẹ',
    artist,
    composer: 'Lê',
  })
  expect(detailsFromTags(source, 'my.song.webm')).toEqual({ title: 'my.song', artist: '', composer: '' })
})
