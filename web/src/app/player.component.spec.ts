import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { expect, test } from 'vitest'
import { SONG_FILE_OPENER } from '../core'
import { OpenedSong, SongFileError } from '../song-file'
import { Player } from './player.component'

// Renders the Player with `opener`, then chooses a file in it.
async function chooseFile(opener: () => Promise<OpenedSong>): Promise<HTMLElement> {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: SONG_FILE_OPENER, useValue: () => opener() }],
  })
  const fixture = TestBed.createComponent(Player)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  const input = element.querySelector('input[type="file"]') as HTMLInputElement
  // jsdom has no DataTransfer to build a FileList, and the Player reads only the first file.
  Object.defineProperty(input, 'files', { value: [new File(['hello'], 'song.lyre')] })
  input.dispatchEvent(new Event('change'))
  await fixture.whenStable()
  return element
}

test('a file that is not a song file shows that, and no video', async () => {
  const element = await chooseFile(() => Promise.reject(new SongFileError('not-a-song-file')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This file is not a song file.')
  expect(element.querySelector('video')).toBeNull()
})

test('a damaged file shows that, and no video', async () => {
  const element = await chooseFile(() => Promise.reject(new SongFileError('damaged')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This song file is damaged or incomplete.')
  expect(element.querySelector('video')).toBeNull()
})

test('any other failure shows the damaged message, without its details', async () => {
  const element = await chooseFile(() => Promise.reject(new Error('secret details')))
  expect(element.querySelector('[role="alert"]')?.textContent?.trim()).toBe('This song file is damaged or incomplete.')
  expect(element.textContent).not.toContain('secret details')
})
