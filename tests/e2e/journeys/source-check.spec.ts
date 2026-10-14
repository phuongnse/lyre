import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, Page, test } from '@playwright/test'
import { Choice, openSongFile } from './song-file'

// scripts/e2e.sh makes these with tests/fixtures/source/make.sh before the journeys run.
const source = (name: string) => fileURLToPath(new URL(`../../../artifacts/e2e/sources/${name}`, import.meta.url))

// The tags that make.sh writes. The artist is a decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
const title = 'Mưa rơi nhẹ'
const artist = 'Hà  Nội'
const composer = 'Lê Văn Thử'

// Opens the source check page and picks `file` with its button.
async function chooseSource(page: Page, file: Choice): Promise<void> {
  await page.goto('/#/source-check')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose a source' }).click()
  await (await chooser).setFiles(file)
}

const details = (page: Page) => page.getByRole('definition')
const labelled = (page: Page, name: string) => page.getByLabel(name, { exact: true })

// The number of seconds in a row such as "2.00 s".
async function secondsIn(page: Page, name: string): Promise<number> {
  const text = (await labelled(page, name).textContent()) ?? ''
  expect(text).toMatch(/^\d+\.\d{2} s$/)
  return parseFloat(text)
}

// Checks a tag row's text byte for byte, or that the row is missing.
async function expectTag(page: Page, name: string, expected: string | undefined): Promise<void> {
  if (expected === undefined) {
    await expect(labelled(page, name)).toHaveCount(0)
    return
  }
  const text = await labelled(page, name).textContent()
  expect(Buffer.from(text ?? '').toString('hex')).toBe(Buffer.from(expected).toString('hex'))
}

// Fails the journey on console errors, such as a CSP or Trusted Types violation.
function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

// The number in a row such as "440 Hz", "2" or "12".
async function numberIn(page: Page, name: string, unit = ''): Promise<number> {
  const text = (await labelled(page, name).textContent()) ?? ''
  expect(text).toMatch(new RegExp(`^\\d+${unit}$`))
  return parseInt(text, 10)
}

// Picks `file`, waits for its details, then decodes it with the button named `button`.
async function decodeSource(page: Page, file: string, button: string): Promise<void> {
  await chooseSource(page, source(file))
  await expect(labelled(page, 'Source details')).toBeVisible()
  await page.getByRole('button', { name: button }).click()
  await expect(labelled(page, 'Decoded audio')).toBeVisible()
}

// Makes this browser report that it cannot play a stored type holding `codec`,
// as a browser without that decoder does.
async function reportUnplayable(page: Page, codec: string): Promise<void> {
  await page.addInitScript((codec) => {
    const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource)
    MediaSource.isTypeSupported = (type) => !type.includes(codec) && isTypeSupported(type)
  }, codec)
}

// The refusal `file` gets in this browser, if any. MP3 is stored as
// `audio/mp4; codecs="mp4a.6B"`, which Playwright's Chromium does not accept.
async function refusalOf(page: Page, file: string): Promise<string | undefined> {
  if (file !== 'song.mp3' && file !== 'cover.mp3') return undefined
  const mp3 = await page.evaluate(() => MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.6B"'))
  return mp3 ? undefined : "This browser cannot play this source's audio (MP3), so a song cannot be made from it."
}

// Checks that the only alert is `refusal`, or that there is none.
async function expectRefusal(page: Page, refusal: string | undefined): Promise<void> {
  if (refusal === undefined) {
    await expect(page.getByRole('alert')).toHaveCount(0)
    return
  }
  await expect(page.getByRole('alert')).toHaveText(refusal)
  await expect(page.getByRole('alert')).toHaveCount(1)
}

const cases = [
  { file: 'song.webm', streams: 'Video and audio', tags: { Title: undefined, Artist: artist, Composer: undefined } },
  { file: 'song.mp3', streams: 'Audio only', tags: { Title: title, Artist: artist, Composer: composer } },
]

for (const { file, streams, tags } of cases) {
  test(`${file} shows its duration, streams and exact tags, and a refusal only if it cannot play`, async ({ page }) => {
    const problems = watchProblems(page)
    await chooseSource(page, source(file))
    await expect(labelled(page, 'Source details')).toBeVisible()
    expect(Math.abs((await secondsIn(page, 'Duration')) - 2)).toBeLessThanOrEqual(0.1)
    await expect(labelled(page, 'Timeline starts at')).toHaveCount(0)
    await expect(labelled(page, 'Streams')).toHaveText(streams)
    for (const [name, value] of Object.entries(tags)) await expectTag(page, name, value)
    await expectRefusal(page, await refusalOf(page, file))
    expect(problems).toEqual([])
  })
}

test('with H.264 unplayable, song.mp4 shows the cannot-play-video reason next to its exact tags', async ({ page }) => {
  const problems = watchProblems(page)
  await reportUnplayable(page, 'avc1')
  await chooseSource(page, source('song.mp4'))
  await expect(page.getByRole('alert')).toHaveText(
    "This browser cannot play this source's video (H.264), so a song cannot be made from it.",
  )
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(labelled(page, 'Source details')).toBeVisible()
  expect(Math.abs((await secondsIn(page, 'Duration')) - 2)).toBeLessThanOrEqual(0.1)
  await expect(labelled(page, 'Streams')).toHaveText('Video and audio')
  await expectTag(page, 'Title', title)
  await expectTag(page, 'Artist', artist)
  await expectTag(page, 'Composer', composer)
  expect(problems).toEqual([])
})

test('with Opus unplayable, song.webm shows the cannot-play-audio reason next to its details', async ({ page }) => {
  const problems = watchProblems(page)
  await reportUnplayable(page, 'opus')
  await chooseSource(page, source('song.webm'))
  await expect(page.getByRole('alert')).toHaveText(
    "This browser cannot play this source's audio (Opus), so a song cannot be made from it.",
  )
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(labelled(page, 'Source details')).toBeVisible()
  await expect(labelled(page, 'Streams')).toHaveText('Video and audio')
  expect(problems).toEqual([])
})

test('a video without audio shows only the no-audio message', async ({ page }) => {
  await chooseSource(page, source('video-only.webm'))
  await expect(page.getByRole('alert')).toHaveText('This file has no audio, so a song cannot be made from it.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(details(page)).toHaveCount(0)
})

test('a text file shows only the cannot-read message', async ({ page }) => {
  const buffer = Buffer.from('These are notes, not a song.\n')
  await chooseSource(page, { name: 'notes.txt', mimeType: 'text/plain', buffer })
  await expect(page.getByRole('alert')).toHaveText('This file is not a video or audio file Lyre can read.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(details(page)).toHaveCount(0)
})

test('a timeline that starts at 1.5 s shows its start offset and a duration counted from zero', async ({ page }) => {
  await chooseSource(page, source('late.webm'))
  await expect(labelled(page, 'Source details')).toBeVisible()
  expect(Math.abs((await secondsIn(page, 'Duration')) - 2)).toBeLessThanOrEqual(0.1)
  expect(Math.abs((await secondsIn(page, 'Timeline starts at')) - 1.5)).toBeLessThanOrEqual(0.05)
})

const formats = [
  { button: 'Decode at 44.1 kHz stereo', rate: 44100, channels: 2 },
  { button: 'Decode at 16 kHz mono', rate: 16000, channels: 1 },
]

for (const file of ['song.webm', 'song.mp3']) {
  for (const { button, rate, channels } of formats) {
    test(`${file} decodes at ${rate} Hz with ${channels} channels, its tone and its length`, async ({ page }) => {
      const problems = watchProblems(page)
      await decodeSource(page, file, button)
      expect(await numberIn(page, 'Sample rate', ' Hz')).toBe(rate)
      expect(await numberIn(page, 'Channels')).toBe(channels)
      expect(Math.abs((await secondsIn(page, 'Length')) - 2)).toBeLessThanOrEqual(0.1)
      expect(Math.abs((await numberIn(page, 'Tone', ' Hz')) - 440)).toBeLessThanOrEqual(5)
      // A refused source can still be decoded on this test page.
      await expectRefusal(page, await refusalOf(page, file))
      expect(problems).toEqual([])
    })
  }
}

test('a timeline that starts at 1.5 s decodes to audio whose sound starts at sample zero', async ({ page }) => {
  const problems = watchProblems(page)
  await decodeSource(page, 'late.webm', 'Decode at 44.1 kHz stereo')
  // Within 10 ms of sample zero.
  expect(await numberIn(page, 'Sound starts at sample')).toBeLessThanOrEqual(441)
  expect(Math.abs((await secondsIn(page, 'Length')) - 2)).toBeLessThanOrEqual(0.1)
  expect(problems).toEqual([])
})

test('without an AAC decoder, decoding the MP4 shows only the no-audio message', async ({ page }) => {
  const problems = watchProblems(page)
  // Some Chromium builds decode AAC. This one is made to report that it cannot,
  // as a browser without an AAC decoder does.
  await page.addInitScript(() => {
    const isConfigSupported = AudioDecoder.isConfigSupported.bind(AudioDecoder)
    AudioDecoder.isConfigSupported = async (config) =>
      config.codec.startsWith('mp4a.') ? { supported: false, config } : isConfigSupported(config)
  })
  await chooseSource(page, source('song.mp4'))
  await expect(labelled(page, 'Source details')).toBeVisible()
  const aac = await page.evaluate(async () => {
    const support = await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1 })
    return support.supported === true
  })
  expect(aac).toBe(false)

  await page.getByRole('button', { name: 'Decode at 44.1 kHz stereo' }).click()
  await expect(page.getByRole('alert')).toHaveText('This file has no audio, so a song cannot be made from it.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(labelled(page, 'Decoded audio')).toHaveCount(0)
  await expect(details(page)).toHaveCount(0)
  expect(problems).toEqual([])
})

test('packaging song.webm shows an Opus WebM original track whose segments total its 2 s', async ({ page }) => {
  const problems = watchProblems(page)
  await chooseSource(page, source('song.webm'))
  await expect(labelled(page, 'Source details')).toBeVisible()
  await page.getByRole('button', { name: 'Package the original track' }).click()
  await expect(labelled(page, 'Original track')).toBeVisible()
  await expect(labelled(page, 'Stored type')).toHaveText('audio/webm; codecs="opus"')
  expect(await numberIn(page, 'Segments')).toBeGreaterThanOrEqual(1)
  expect(Math.abs((await secondsIn(page, 'Total duration')) - 2)).toBeLessThanOrEqual(0.1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  // A Trusted Types violation from the new worker would show here.
  expect(problems).toEqual([])
})

// Picks `file`, then karaoke.webm with the karaoke button, and makes the tracks.
async function makeTracks(page: Page, file = 'song.webm'): Promise<void> {
  await chooseSource(page, source(file))
  await expect(labelled(page, 'Source details')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose a karaoke track' }).click()
  await (await chooser).setFiles(source('karaoke.webm'))
  await page.getByRole('button', { name: 'Make the tracks' }).click()
}

// The start and end of each segment in a list of rows such as "0–2000 ms".
async function segmentsIn(page: Page, name: string): Promise<[number, number][]> {
  const rows = await labelled(page, name).getByRole('listitem').allTextContents()
  return rows.map((row) => {
    const match = /^(\d+)–(\d+) ms$/.exec(row)
    expect(match, row).not.toBeNull()
    return [parseInt(match![1]!, 10), parseInt(match![2]!, 10)]
  })
}

test('song.webm with karaoke.webm cuts both audio tracks at the same times, within 50 ms', async ({ page }) => {
  const problems = watchProblems(page)
  await makeTracks(page)
  await expect(labelled(page, 'Karaoke segments')).toBeVisible()
  const original = await segmentsIn(page, 'Original segments')
  const karaoke = await segmentsIn(page, 'Karaoke segments')
  expect(original.length).toBeGreaterThanOrEqual(1)
  expect(karaoke.length).toBe(original.length)
  for (const [index, [start, end]] of karaoke.entries()) {
    expect(Math.abs(start - original[index]![0])).toBeLessThanOrEqual(50)
    expect(Math.abs(end - original[index]![1])).toBeLessThanOrEqual(50)
  }
  // karaoke.webm lasts 3 s, so fitting cut it to the source's 2 s.
  expect(Math.abs((await secondsIn(page, 'Song duration')) - 2)).toBeLessThanOrEqual(0.1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('with Opus encoding unsupported, making the tracks shows only the cannot-encode message', async ({
  page,
}) => {
  const problems = watchProblems(page)
  // Makes this browser report that it cannot encode Opus, as a browser without that encoder does.
  await page.addInitScript(() => {
    const isConfigSupported = AudioEncoder.isConfigSupported.bind(AudioEncoder)
    AudioEncoder.isConfigSupported = async (config) =>
      config.codec.startsWith('opus') ? { supported: false, config } : isConfigSupported(config)
  })
  await makeTracks(page)
  await expect(page.getByRole('alert')).toHaveText('This browser cannot encode audio, so a song cannot be made in it.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(labelled(page, 'Original segments')).toHaveCount(0)
  await expect(labelled(page, 'Karaoke segments')).toHaveCount(0)
  await expect(labelled(page, 'Song duration')).toHaveCount(0)
  await expect(labelled(page, 'Video segments')).toHaveCount(0)
  expect(problems).toEqual([])
})

test("song.webm gives video segments that follow on and end within 1,000 ms of the song's end", async ({ page }) => {
  const problems = watchProblems(page)
  await makeTracks(page)
  await expect(labelled(page, 'Video segments')).toBeVisible()
  const video = await segmentsIn(page, 'Video segments')
  const karaoke = await segmentsIn(page, 'Karaoke segments')
  expect(video.length).toBeGreaterThanOrEqual(1)
  expect(video[0]![0]).toBeLessThanOrEqual(50)
  for (const [index, [start, end]] of video.entries()) {
    if (index > 0) expect(start).toBe(video[index - 1]![1])
    expect(end - start).toBeGreaterThanOrEqual(1)
    expect(end - start).toBeLessThanOrEqual(20_000)
  }
  // The song lasts as long as its karaoke track.
  expect(Math.abs(video[video.length - 1]![1] - karaoke[karaoke.length - 1]![1])).toBeLessThanOrEqual(1_000)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('song.mp3 gives the audio tracks and no video segments', async ({ page }) => {
  const problems = watchProblems(page)
  await makeTracks(page, 'song.mp3')
  await expect(labelled(page, 'Karaoke segments')).toBeVisible()
  expect((await segmentsIn(page, 'Karaoke segments')).length).toBeGreaterThanOrEqual(1)
  await expect(labelled(page, 'Video segments')).toHaveCount(0)
  // A refused source can still be made on this test page.
  await expectRefusal(page, await refusalOf(page, 'song.mp3'))
  expect(problems).toEqual([])
})

test('reading a source sends nothing: every request is a same-origin GET with no body', async ({ page }) => {
  await page.goto('/#/source-check')
  await expect(page.getByRole('button', { name: 'Choose a source' })).toBeEnabled()
  const origin = new URL(page.url()).origin
  const requests: { method: string; body: string | null; origin: string }[] = []
  page.on('request', (request) =>
    requests.push({ method: request.method(), body: request.postData(), origin: new URL(request.url()).origin }),
  )

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose a source' }).click()
  await (await chooser).setFiles(source('song.mp4'))
  await expect(labelled(page, 'Composer')).toBeVisible()

  for (const request of requests) expect(request).toEqual({ method: 'GET', body: null, origin })
})

test('the main page has no link to the source check page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open a song file' })).toBeVisible()
  await expect(page.locator('a[href*="source-check"]')).toHaveCount(0)
})

test("the built web client ships Mediabunny's licence notice", async ({ request }) => {
  const response = await request.get('/3rdpartylicenses.txt')
  expect(response.ok()).toBe(true)
  const text = await response.text()
  expect(text).toContain('mediabunny')
  expect(text).toContain('Mozilla Public License Version 2.0')
})

// Picks `file`, makes its thumbnail with the button, and returns the page's
// thumbnail image once the button's work is done.
async function makeThumbnail(page: Page, file: string) {
  await chooseSource(page, source(file))
  await expect(labelled(page, 'Source details')).toBeVisible()
  await page.getByRole('button', { name: 'Make the thumbnail' }).click()
  return page.getByAltText('Thumbnail', { exact: true })
}

// Checks that `img` shows a JPEG of 1 to 1,048,576 bytes that the browser
// decodes at `size`, and that the size row tells the byte count.
async function expectJpeg(page: Page, img: ReturnType<Page['getByAltText']>, size: [number, number]): Promise<void> {
  await expect(img).toBeVisible()
  const src = (await img.getAttribute('src')) ?? ''
  expect(src.startsWith('data:image/jpeg;base64,')).toBe(true)
  const bytes = Buffer.from(src.slice('data:image/jpeg;base64,'.length), 'base64')
  expect(bytes.length).toBeGreaterThanOrEqual(1)
  expect(bytes.length).toBeLessThanOrEqual(1_048_576)
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  expect(await img.evaluate((el: HTMLImageElement) => el.decode().then(() => [el.naturalWidth, el.naturalHeight]))).toEqual(size)
  await expect(labelled(page, 'Thumbnail size')).toHaveText(`${bytes.length} bytes`)
}

test('song.webm gives its middle frame as a JPEG thumbnail', async ({ page }) => {
  const problems = watchProblems(page)
  const img = await makeThumbnail(page, 'song.webm')
  await expectJpeg(page, img, [64, 36])
  expect(problems).toEqual([])
})

test('cover.mp3 gives its PNG cover art as a JPEG thumbnail scaled to 360x360', async ({ page }) => {
  const problems = watchProblems(page)
  const img = await makeThumbnail(page, 'cover.mp3')
  await expectJpeg(page, img, [360, 360])
  await expectRefusal(page, await refusalOf(page, 'cover.mp3'))
  expect(problems).toEqual([])
})

test('song.mp3 has no cover art, so it gives no thumbnail', async ({ page }) => {
  const problems = watchProblems(page)
  const img = await makeThumbnail(page, 'song.mp3')
  await expect(page.getByRole('status')).toHaveText('This source gives no thumbnail.')
  await expect(img).toHaveCount(0)
  expect(problems).toEqual([])
})

// Picks `file` with the button named `button`.
async function pick(page: Page, button: string, file: Choice): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button }).click()
  await (await chooser).setFiles(file)
}

const text = (name: string, value: string): Choice => ({ name, mimeType: 'text/plain', buffer: Buffer.from(value) })

// The lyrics of the song files the journeys make: one lyric line of two syllables.
const songLyrics = 'Mưa rơi\n'
// A timing that fits the 2 s sources, and one whose last syllable ends at 5 s.
const goodTiming = '0 500 Mưa\n500 1000 rơi\n'
const pastEndTiming = '0 500 Mưa\n500 5000 rơi\n'

// Picks `file`, karaoke.webm, the lyrics, a timing file holding `timing` and
// the Female vocal role, then makes the song file with the button.
async function makeSong(page: Page, file: string, timing: string): Promise<void> {
  await chooseSource(page, source(file))
  await expect(labelled(page, 'Source details')).toBeVisible()
  await pick(page, 'Choose a karaoke track', source('karaoke.webm'))
  await pick(page, 'Choose the lyrics', text('lyrics.txt', songLyrics))
  await pick(page, 'Choose a timing file', text('timing.txt', timing))
  await page.getByRole('radio', { name: 'Female' }).click()
  await page.getByRole('button', { name: 'Make the song file' }).click()
}

// Downloads the song file with the page's link, and returns its name and bytes.
async function downloadSong(page: Page): Promise<{ name: string; bytes: Buffer }> {
  const link = page.getByRole('link', { name: 'Download the song file' })
  await expect(link).toBeVisible()
  const download = page.waitForEvent('download')
  await link.click()
  const done = await download
  const path = await done.path()
  return { name: done.suggestedFilename(), bytes: readFileSync(path) }
}

// The chunk type of every index entry. The header's entry_count is the u32 at
// byte 12, and each 24-byte entry from byte 32 starts with its u16 type.
function chunkTypes(file: Buffer): number[] {
  const count = file.readUInt32LE(12)
  return Array.from({ length: count }, (_, index) => file.readUInt16LE(32 + 24 * index))
}

const THUMBNAIL = 2
const VIDEO_INIT = 16
const VIDEO_SEGMENT = 17

const songSeconds = (page: Page) =>
  page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)

// Counts the seeks of the Player's video, so a journey can show that none happened.
async function countSeeks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement
    const counted = window as unknown as { lyreSeeks: number }
    counted.lyreSeeks = 0
    video.addEventListener('seeking', () => counted.lyreSeeks++)
  })
}
const seeks = (page: Page) => page.evaluate(() => (window as unknown as { lyreSeeks: number }).lyreSeeks)

test('song.webm makes a song file with video and a thumbnail, which the Player plays and switches', async ({
  page,
}) => {
  const problems = watchProblems(page)
  await makeSong(page, 'song.webm', goodTiming)
  const { name, bytes } = await downloadSong(page)
  expect(name).toBe('song.lyre')
  expect(chunkTypes(bytes)).toEqual(expect.arrayContaining([THUMBNAIL, VIDEO_INIT, VIDEO_SEGMENT]))

  await openSongFile(page, { name, mimeType: 'application/octet-stream', buffer: bytes })
  const video = page.getByLabel('Song video')
  await expect(video).toBeVisible()
  // song.webm has no title tag, so the title is its file name without the extension.
  await expect(page.getByRole('list', { name: 'Library' }).getByRole('button', { name: 'song', exact: true })).toBeVisible()
  await countSeeks(page)
  await page.getByRole('button', { name: 'Play' }).click()
  const poll = { intervals: [50] }
  // Chromium counts the video bytes it decoded.
  const decodedVideo = () =>
    video.evaluate(
      (element) => (element as HTMLVideoElement & { webkitVideoDecodedByteCount: number }).webkitVideoDecodedByteCount,
    )
  await expect.poll(decodedVideo, poll).toBeGreaterThan(0)
  await expect.poll(() => songSeconds(page), poll).toBeGreaterThan(0.5)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  const paused = await songSeconds(page)
  const seeksBefore = await seeks(page)

  await page.getByRole('radio', { name: 'Original' }).click()
  await expect(page.getByRole('radio', { name: 'Original' })).toBeChecked()
  expect(await songSeconds(page)).toBe(paused)
  expect(await seeks(page)).toBe(seeksBefore)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('song.mp3 makes a song file without video or a thumbnail, which the Player opens', async ({ page }) => {
  const problems = watchProblems(page)
  await makeSong(page, 'song.mp3', goodTiming)
  const { name, bytes } = await downloadSong(page)
  expect(name).toBe('song.lyre')
  const types = chunkTypes(bytes)
  for (const type of [THUMBNAIL, VIDEO_INIT, VIDEO_SEGMENT]) expect(types).not.toContain(type)

  await openSongFile(page, { name, mimeType: 'application/octet-stream', buffer: bytes })
  // MP3 is stored as `audio/mp4; codecs="mp4a.6B"`, which Playwright's Chromium does not accept.
  const mp3 = await page.evaluate(() => MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.6B"'))
  if (mp3) {
    await page.getByRole('button', { name: 'Play' }).click()
    await expect.poll(() => songSeconds(page), { intervals: [50] }).toBeGreaterThan(0.5)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } else {
    await expect(page.getByRole('alert')).toHaveText("This device cannot play this song's original track.")
    await expect(page.getByRole('alert')).toHaveCount(1)
  }
  expect(problems).toEqual([])
})

test('a timing that ends after the song shows the refusal and offers no song file', async ({ page }) => {
  const problems = watchProblems(page)
  await makeSong(page, 'song.webm', pastEndTiming)
  await expect(page.getByRole('alert')).toHaveText('The timing ends after the song, so the song file was not made.')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Download the song file' })).toHaveCount(0)
  expect(problems).toEqual([])
})
