import type { CannotPlay, SourceProblem } from '../source'
import { messages } from './messages'

// The reason a source cannot be played, naming the track and the codec.
export function cannotPlayMessage({ track, codec }: CannotPlay): string {
  const name = codec === null ? messages.unknownCodec : messages.codecNames[codec]
  return messages.sourceCannotPlay[track](name)
}

// The message for a refused source. The error's own text is never shown: it is
// not meant for users.
export function sourceProblemMessage(problem: SourceProblem): string {
  return problem === 'no-audio' ? messages.sourceNoAudio : messages.sourceUnreadable
}
