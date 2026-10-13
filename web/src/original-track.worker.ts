import { makeKaraoke } from './karaoke-track'
import { PackageReply, PackageRequest, SegmentTimes } from './original-track-messages'
import { PackagedTrack, packageOriginal } from './original-track'
import { makeThumbnail } from './thumbnail'
import { checkVideoEnd, packageVideo, videoRefusal } from './video-track'

// Packages a source's audio into the original track, and can then make the
// karaoke track cut at its times and the video track, and makes a source's
// thumbnail, off the page's main thread. It answers with a summary, never with
// the error's text.
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
  } else if (request.type === 'thumbnail') {
    void makeThumbnail(request.file).then(
      (bytes) =>
        postMessage({ type: 'thumbnail-done', bytes } satisfies PackageReply, bytes === null ? [] : [bytes.buffer]),
      () => postMessage({ type: 'failed' } satisfies PackageReply),
    )
  } else if (request.type === 'make-audio') {
    void makeAudio(request.file, request.karaokeFile, request.storedType, request.videoType).then(
      (reply) => postMessage(reply),
      (error: unknown) => {
        // Only a fixed reason code crosses, never the error's text.
        const reason = videoRefusal(error)
        postMessage((reason === undefined ? { type: 'failed' } : { type: 'failed', reason }) satisfies PackageReply)
      },
    )
  }
})

async function makeAudio(
  file: File,
  karaokeFile: File,
  storedType: string,
  videoType: string | undefined,
): Promise<PackageReply> {
  const original = await packageOriginal(file, storedType)
  const karaoke = await makeKaraoke(karaokeFile, original)
  const karaokeTimes = segmentTimes(karaoke)
  // The song lasts as long as its karaoke track.
  const songDurationMs = karaokeTimes[karaokeTimes.length - 1]!.endMs
  const reply: PackageReply = {
    type: 'audio-done',
    original: segmentTimes(original),
    karaoke: karaokeTimes,
    songDurationMs,
  }
  // An audio-only source gives no video.
  const video = videoType === undefined ? null : await packageVideo(file, videoType)
  if (video !== null) {
    checkVideoEnd(video, songDurationMs)
    reply.video = segmentTimes(video)
  }
  return reply
}

function segmentTimes({ startMs, segments }: PackagedTrack): SegmentTimes[] {
  let start = startMs
  return segments.map(({ durationMs }) => {
    const times = { startMs: start, endMs: start + durationMs }
    start = times.endMs
    return times
  })
}
