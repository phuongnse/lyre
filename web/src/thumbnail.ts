import { BlobSource, Input, MP3, MP4, VideoSampleSink, WEBM } from 'mediabunny'
import { PackageError } from './original-track'

// Makes the song's thumbnail from a source: part of stage 8 of processing
// (docs/domain/knowledge.md#processing). A video gives its middle frame, and
// an audio source gives its cover art. Either becomes a JPEG that fits within
// 640×360 and stays within the song file's limit
// (docs/reference/song-file-format-v0.md#thumbnail). An audio source without
// usable cover art gives no thumbnail, because the thumbnail is optional. The
// code uses only OffscreenCanvas and createImageBitmap, so it can run in a Web
// Worker.

export const THUMBNAIL_WIDTH = 640
export const THUMBNAIL_HEIGHT = 360
// The largest JPEG the song file format allows.
export const MAX_THUMBNAIL_BYTES = 1_048_576
// The JPEG qualities to try, from the best down to the lowest.
export const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]

// The size of an image of `width` × `height` scaled to fit within 640×360,
// keeping its aspect ratio. It is never enlarged.
export function fitWithin(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMBNAIL_WIDTH / width, THUMBNAIL_HEIGHT / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

// The bytes of the first JPEG, from the best quality down, that is at most
// `maxBytes`, or null when even the lowest quality is too large. An empty
// JPEG is no JPEG.
export async function smallEnoughJpeg(
  encode: (quality: number) => Promise<Blob>,
  maxBytes = MAX_THUMBNAIL_BYTES,
): Promise<Uint8Array | null> {
  for (const quality of JPEG_QUALITIES) {
    const blob = await encode(quality)
    if (blob.size >= 1 && blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer())
  }
  return null
}

// The thumbnail of `file` as a JPEG, or null when the source gives none.
export async function makeThumbnail(file: Blob): Promise<Uint8Array | null> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] })
  try {
    const track = await input.getPrimaryVideoTrack()
    const canvas = track === null ? await coverCanvas(input) : await middleFrameCanvas(input, track)
    if (canvas === null) return null
    return await smallEnoughJpeg((quality) => canvas.convertToBlob({ type: 'image/jpeg', quality }))
  } catch (error) {
    if (error instanceof PackageError) throw error
    // The error's own text is never passed on.
    throw new PackageError('unexpected')
  } finally {
    input.dispose()
  }
}

// The frame shown at the middle of the source's timeline.
async function middleFrameCanvas(
  input: Input,
  track: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>,
): Promise<OffscreenCanvas | null> {
  const start = Math.max(0, await input.getFirstTimestamp())
  const end = await input.computeDuration()
  const middle = start + (end - start) / 2
  const sample = await new VideoSampleSink(track).getSample(middle)
  if (sample === null) return null
  try {
    const { width, height } = fitWithin(sample.displayWidth, sample.displayHeight)
    const canvas = new OffscreenCanvas(width, height)
    sample.draw(canvas.getContext('2d')!, 0, 0, width, height)
    return canvas
  } finally {
    sample.close()
  }
}

// The source's cover art, the front cover if there are several pictures. A
// picture that cannot be decoded gives null.
async function coverCanvas(input: Input): Promise<OffscreenCanvas | null> {
  const images = (await input.getMetadataTags()).images ?? []
  const image = images.find(({ kind }) => kind === 'coverFront') ?? images[0]
  if (image === undefined) return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mimeType }))
  } catch {
    return null
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    return canvas
  } finally {
    bitmap.close()
  }
}
