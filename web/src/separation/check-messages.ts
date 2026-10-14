import { Backend } from './backend'

// What the page sends the separator check worker: the checked test separator file.
export type SeparatorCheckRequest = { type: 'run'; separator: Blob; baseUri: string; forced?: Backend }

// What the worker answers: the backend that ran and the dimensions of `stems_spec`, or a failure.
export type SeparatorCheckReply = { type: 'ran'; backend: Backend; stemsSpec: number[] } | { type: 'failed' }
