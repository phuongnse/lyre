import { makeKaraoke } from './karaoke-track'
import { PackageReply, PackageRequest, SegmentTimes } from './original-track-messages'
import { PackagedTrack, packageOriginal } from './original-track'

// Packages a source's audio into the original track, and can then make the
// karaoke track cut at its times, off the page's main thread. It answers with
// a summary, never with the error's text.
addEventListener('message', (event: MessageEvent<PackageRequest>) => {
  const request = event.data
  if (request.type === 'package') {
    void packageOriginal(request.file, request.storedType).then(
      ({ storedType, segments }) =>
        postMessage({
          type: 'done',
          storedType,
          segmentCount: segments.length,
          durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0),
        } satisfies PackageReply),
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  } else if (request.type === 'make-audio') {
    void makeAudio(request.file, request.karaokeFile, request.storedType).then(
      (reply) => postMessage(reply),
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  }
})

async function makeAudio(file: File, karaokeFile: File, storedType: string): Promise<PackageReply> {
  const original = await packageOriginal(file, storedType)
  const karaoke = await makeKaraoke(karaokeFile, original)
  const karaokeTimes = segmentTimes(karaoke)
  return {
    type: 'audio-done',
    original: segmentTimes(original),
    karaoke: karaokeTimes,
    // The song lasts as long as its karaoke track.
    songDurationMs: karaokeTimes[karaokeTimes.length - 1]!.endMs,
  }
}

function segmentTimes({ startMs, segments }: PackagedTrack): SegmentTimes[] {
  let start = startMs
  return segments.map(({ durationMs }) => {
    const times = { startMs: start, endMs: start + durationMs }
    start = times.endMs
    return times
  })
}
