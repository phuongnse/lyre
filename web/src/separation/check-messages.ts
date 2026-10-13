import { Backend } from './backend'

// What the page sends the separator check worker: the checked test separator files.
export type SeparatorCheckRequest = { type: 'run'; graph: Blob; weights: Blob; baseUri: string; forced?: Backend }

// What the worker answers: the backend that ran and each output's dimensions, or a failure.
export type SeparatorCheckReply =
  { type: 'ran'; backend: Backend; xOut: number[]; xtOut: number[] } | { type: 'failed' }
