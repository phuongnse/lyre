import { expect, test } from 'vitest'
import { SongRefusal, VideoRefusal } from '../../original-track-messages'
import { makeFailedMessage, makeSongFailedMessage } from './source-check.component'

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
