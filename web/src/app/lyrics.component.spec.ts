import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { OpenedSong } from '../song-file'
import { Lyrics } from './lyrics.component'

afterEach(() => {
  vi.unstubAllGlobals()
})

interface SongOptions {
  position?: () => number
  total?: () => number
  countdownLines?: number[]
  lyrics?: OpenedSong['lyrics']
  layOut?: OpenedSong['layOut']
}

// A song whose lyrics are by default "Mưa\trơi  nhẹ", laid out as one display
// line with no countdown. Its sweep position is whatever `position` returns, and
// its total of countdown dots changed is whatever `total` returns.
function song({
  position = () => 0,
  total = () => 0,
  countdownLines = [],
  lyrics,
  layOut = () => [{ lyricLine: 0, start: 0, end: 3 }],
}: SongOptions = {}): OpenedSong {
  const timing = { lyricLine: 0, startMs: 0, endMs: 0 }
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa', artist: '', composer: '' },
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
    read: () => Promise.reject(new Error('not read in these tests')),
    close: () => undefined,
  }
}

// Renders the lyrics of `opened` and waits for its `paragraphs` display lines to
// be laid out. jsdom has no ResizeObserver, so it gets one that does nothing.
async function render(opened: OpenedSong, paragraphs = 1): Promise<HTMLElement> {
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
    expect(element.querySelectorAll('p')).toHaveLength(paragraphs)
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
    2,
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
  expect([...element.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Mưa\trơi', 'nhẹ'])
})

test('only the first display line of a lyric line with a countdown shows it', async () => {
  const layOut = () => [
    { lyricLine: 0, start: 0, end: 2 },
    { lyricLine: 0, start: 2, end: 3 },
  ]
  const withCountdown = await render(song({ countdownLines: [0], layOut }), 2)
  expect(withCountdown.querySelectorAll('[role=progressbar]')).toHaveLength(1)
  expect(withCountdown.querySelectorAll('p')[0].querySelectorAll('[role=progressbar]')).toHaveLength(1)
  expect([...withCountdown.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Mưa\trơi', 'nhẹ'])
  TestBed.resetTestingModule()

  const without = await render(song({ countdownLines: [], layOut }), 2)
  expect(without.querySelectorAll('[role=progressbar]')).toHaveLength(0)
})
