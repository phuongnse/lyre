import { expect, test } from 'vitest'
import { VideoRefusal } from '../../original-track-messages'
import { makeFailedMessage } from './source-check.component'

// Each video refusal gets its own message, and any other failure the general one.
test.each<[VideoRefusal | undefined, string]>([
  ['keyframe gap', "This source's keyframes are more than 20 s apart, so a song cannot be made from it."],
  ['group too large', 'This source has a group of video frames over 64 MiB, so a song cannot be made from it.'],
  [undefined, 'The tracks could not be made for a song.'],
])('a failure with reason %s shows its message', (reason, message) => {
  expect(makeFailedMessage(reason)).toBe(message)
})
