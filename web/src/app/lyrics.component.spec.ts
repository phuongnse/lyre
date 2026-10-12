import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { OpenedSong } from '../song-file'
import { Lyrics } from './lyrics.component'

afterEach(() => {
  vi.unstubAllGlobals()
})

// A song whose lyrics are "Mưa\trơi  nhẹ", laid out as one display line. Its
// sweep position is whatever `position` returns.
function song(position: () => number): OpenedSong {
  const timing = { lyricLine: 0, startMs: 0, endMs: 0 }
  return {
    songId: '00112233445566778899aabbccddeeff',
    details: { title: 'Mưa', artist: '', composer: '' },
    durationMs: 1000,
    karaoke: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    original: { init: { position: 0, offset: 0, length: 0, startMs: 0, durationMs: 0 }, segments: [] },
    lyrics: [
      { ...timing, text: 'Mưa', separator: '' },
      { ...timing, text: 'rơi', separator: '\t' },
      { ...timing, text: 'nhẹ', separator: '  ' },
    ],
    layOut: () => [{ lyricLine: 0, start: 0, end: 3 }],
    sweepPosition: position,
    read: () => Promise.reject(new Error('not read in these tests')),
    close: () => undefined,
  }
}

// Renders the lyrics of `opened` and waits for them to be laid out. jsdom has
// no ResizeObserver, so it gets one that does nothing.
async function render(opened: OpenedSong): Promise<HTMLElement> {
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
    expect(element.querySelectorAll('p')).toHaveLength(1)
  })
  return element
}

test('a display line holds the exact text of its lyric line, tab and double space included', async () => {
  const element = await render(song(() => 0))
  expect(element.querySelector('section')?.getAttribute('aria-label')).toBe('Lyrics')
  expect(element.querySelector('p')?.textContent).toBe('Mưa\trơi  nhẹ')
})

test('the syllable being sung is current, and the ones before it are sung', async () => {
  let position = 1.5
  const element = await render(song(() => position))
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
