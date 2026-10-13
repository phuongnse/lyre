// Why a source was refused. Mediabunny's own messages are not meant for users.
// This file uses no DOM, so a Web Worker can import it.
export type SourceProblem = 'no-audio' | 'unreadable'

export class SourceError extends Error {
  constructor(readonly problem: SourceProblem) {
    super(problem)
    this.name = 'SourceError'
  }
}
