import { PackageReply, PackageRequest } from './original-track-messages'
import { packageOriginal } from './original-track'

// Packages a source's audio into the original track, off the page's main
// thread. It answers with a summary, never with the error's text.
addEventListener('message', (event: MessageEvent<PackageRequest>) => {
  if (event.data.type !== 'package') return
  void packageOriginal(event.data.file, event.data.storedType).then(
    ({ storedType, segments }) =>
      postMessage({
        type: 'done',
        storedType,
        segmentCount: segments.length,
        durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0),
      } satisfies PackageReply),
    () => postMessage({ type: 'failed' } satisfies PackageReply),
  )
})
