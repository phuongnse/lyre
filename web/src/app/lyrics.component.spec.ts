import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { LyricsRows, OpenedSong } from '../song-file'
import { Lyrics, lyricFontSize } from './lyrics.component'

afterEach(() => {
  vi.unstubAllGlobals()
})

interface SongOptions {
  position?: () => number
  total?: () => number
  countdownLines?: number[]
  lyrics?: OpenedSong['lyrics']
  layOut?: OpenedSong['layOut']
  rows?: () => LyricsRows
}

// A song whose lyrics are by default "Mưa\trơi  nhẹ", laid out as one display
// line with no countdown. Its sweep position is whatever `position` returns, its
// total of countdown dots changed is whatever `total` returns, and its rows are
// whatever `rows` returns: by default the first two display lines.
function song({
  position = () => 0,
  total = () => 0,
  countdownLines = [],
  lyrics,
  layOut = () => [{ lyricLine: 0, start: 0, end: 3 }],
  rows = () => ({ top: 0, bottom: 1 }),
}: SongOptions = {}): OpenedSong {
  const timing = { lyricLine: 0, startMs: 0, endMs: 0 }
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa', artist: '', composer: '', vocalRole: 'female' },
    durationMs: 1000,
    karaoke: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    original: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    lyrics: lyrics ?? [
      { ...timing, text: 'Mưa', separator: '' },
      { ...timing, text: 'rơi', separator: '\t' },
      { ...timing, text: 'nhẹ', separator: '  ' },
    ],
    layOut,
    sweepPosition: position,
    countdownLines,
    dotsChanged: total,
    lyricsRows: rows,
    read: () => Promise.reject(new Error('not read in these tests')),
    close: () => undefined,
  }
}

// Renders the lyrics of `opened` and waits for its two rows to show the texts in
// `expected`. jsdom has no ResizeObserver, so it gets one that does nothing.
// The text of each row.
function texts(element: HTMLElement): (string | null)[] {
  return [...element.querySelectorAll('p')].map((p) => p.textContent)
}

async function render(opened: OpenedSong, expected: string[] = ['Mưa\trơi  nhẹ', '']): Promise<HTMLElement> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] })
  const fixture = TestBed.createComponent(Lyrics)
  fixture.componentRef.setInput('song', opened)
  fixture.componentRef.setInput('video', document.createElement('video'))
  const element = fixture.nativeElement as HTMLElement
  await vi.waitFor(async () => {
    await fixture.whenStable()
    expect(texts(element)).toEqual(expected)
  })
  return element
}

test('a display line holds the exact text of its lyric line, tab and double space included', async () => {
  const element = await render(song())
  expect(element.querySelector('section')?.getAttribute('aria-label')).toBe('Lyrics')
  expect(element.querySelector('p')?.textContent).toBe('Mưa\trơi  nhẹ')
})

test('the syllable being sung is current, and the ones before it are sung', async () => {
  let position = 1.5
  const element = await render(song({ position: () => position }))
  const syllables = () => [...element.querySelectorAll('p span[data-text]')]
  const current = () => syllables().map((span) => span.getAttribute('aria-current'))
  const sung = () => syllables().map((span) => span.classList.contains('sung'))
  await vi.waitFor(() => expect(current()).toEqual([null, 'true', null]))
  expect(sung()).toEqual([true, false, false])

  // Between syllables, none is current.
  position = 2
  await vi.waitFor(() => expect(current()).toEqual([null, null, null]))
  expect(sung()).toEqual([true, true, false])

  // Going back un-sings the syllables after the new time.
  position = 0.25
  await vi.waitFor(() => expect(current()).toEqual(['true', null, null]))
  expect(sung()).toEqual([false, false, false])
})

test('the countdown dots changed follow the core count, and the lines stay exact', async () => {
  let total = 0
  const timing = { startMs: 0, endMs: 0 }
  const element = await render(
    song({
      total: () => total,
      countdownLines: [0, 1],
      lyrics: [
        { ...timing, lyricLine: 0, text: 'Mưa', separator: '' },
        { ...timing, lyricLine: 0, text: 'rơi', separator: '\t' },
        { ...timing, lyricLine: 1, text: 'nhẹ', separator: '\n' },
      ],
      layOut: () => [
        { lyricLine: 0, start: 0, end: 2 },
        { lyricLine: 1, start: 2, end: 3 },
      ],
    }),
    ['Mưa\trơi', 'nhẹ'],
  )
  const countdowns = () => [...element.querySelectorAll('[role=progressbar]')]
  const values = () => countdowns().map((countdown) => countdown.getAttribute('aria-valuenow'))
  const changed = () =>
    countdowns().map((countdown) =>
      [...countdown.querySelectorAll('.dot')].map((dot) => dot.classList.contains('changed')),
    )
  const dots = (count: number) => [0, 1, 2, 3].map((i) => i < count)
  expect(countdowns().map((countdown) => countdown.getAttribute('aria-label'))).toEqual(['Countdown', 'Countdown'])

  for (const [next, expected] of [
    [0, [0, 0]],
    [2, [2, 0]],
    [6, [4, 2]],
    // Going back undoes the steps after the new time.
    [1, [1, 0]],
  ] as const) {
    total = next
    await vi.waitFor(() => expect(values()).toEqual(expected.map(String)))
    expect(changed()).toEqual(expected.map(dots))
  }
  expect(texts(element)).toEqual(['Mưa\trơi', 'nhẹ'])
})

test('only the first display line of a lyric line with a countdown shows it', async () => {
  const layOut = () => [
    { lyricLine: 0, start: 0, end: 2 },
    { lyricLine: 0, start: 2, end: 3 },
  ]
  const withCountdown = await render(song({ countdownLines: [0], layOut }), ['Mưa\trơi', 'nhẹ'])
  expect(withCountdown.querySelectorAll('[role=progressbar]')).toHaveLength(1)
  expect(withCountdown.querySelectorAll('p')[0].querySelectorAll('[role=progressbar]')).toHaveLength(1)
  TestBed.resetTestingModule()

  const without = await render(song({ countdownLines: [], layOut }), ['Mưa\trơi', 'nhẹ'])
  expect(without.querySelectorAll('[role=progressbar]')).toHaveLength(0)
})

test('the rows show the display lines the core picks, and follow when it picks others', async () => {
  const timing = { startMs: 0, endMs: 0 }
  let rows: LyricsRows = { top: 0, bottom: 1 }
  const element = await render(
    song({
      lyrics: [
        { ...timing, lyricLine: 0, text: 'Mưa', separator: '' },
        { ...timing, lyricLine: 0, text: 'rơi', separator: '\t' },
        { ...timing, lyricLine: 0, text: 'nhẹ', separator: '  ' },
        { ...timing, lyricLine: 1, text: 'Em', separator: '\n' },
      ],
      layOut: () => [
        { lyricLine: 0, start: 0, end: 2 },
        { lyricLine: 0, start: 2, end: 3 },
        { lyricLine: 1, start: 3, end: 4 },
      ],
      rows: () => rows,
    }),
    ['Mưa\trơi', 'nhẹ'],
  )
  expect(element.querySelectorAll('p')[1].classList.contains('bottom')).toBe(true)

  rows = { top: 2, bottom: undefined }
  await vi.waitFor(() => expect(texts(element)).toEqual(['Em', '']))

  // A position outside the list shows an empty row.
  rows = { top: undefined, bottom: 7 }
  await vi.waitFor(() => expect(texts(element)).toEqual(['', '']))

  rows = { top: 1, bottom: 0 }
  await vi.waitFor(() => expect(texts(element)).toEqual(['nhẹ', 'Mưa\trơi']))
})

test('the lyric font size is 1/10 of the video height, never under 16 px', () => {
  expect([0, 140, 160, 720].map(lyricFontSize)).toEqual([16, 16, 16, 72])
})
