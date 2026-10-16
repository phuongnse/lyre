import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { expect, test, vi } from 'vitest'
import { RestoreSongs } from './restore-songs.component'
import { RestoreOutcome, SONG_RESTORER } from './restore-songs'

const WORDS = 'alpha bravo charlie delta'

async function render(restore: (words: string, files: readonly File[]) => Promise<RestoreOutcome>) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: SONG_RESTORER, useValue: restore }],
  })
  const fixture = TestBed.createComponent(RestoreSongs)
  const kept = vi.fn()
  fixture.componentInstance.keyKept.subscribe(kept)
  await fixture.whenStable()
  return { fixture, kept }
}

const elementOf = (fixture: ComponentFixture<RestoreSongs>) => fixture.nativeElement as HTMLElement

const field = (fixture: ComponentFixture<RestoreSongs>) => elementOf(fixture).querySelector('textarea')!

async function chooseFiles(fixture: ComponentFixture<RestoreSongs>, names: string[]) {
  const input = elementOf(fixture).querySelector<HTMLInputElement>('input[type=file]')!
  // jsdom has no DataTransfer, so the input gets an array of files, which reads like a FileList.
  Object.defineProperty(input, 'files', { value: names.map((name) => new File(['x'], name)), configurable: true })
  input.dispatchEvent(new Event('change'))
  await fixture.whenStable()
}

async function press(fixture: ComponentFixture<RestoreSongs>, name: string) {
  const button = [...elementOf(fixture).querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  expect(button).toBeDefined()
  button!.click()
  await fixture.whenStable()
}

const alerts = (fixture: ComponentFixture<RestoreSongs>) =>
  [...elementOf(fixture).querySelectorAll('[role=alert]')].map((el) => el.textContent?.trim())

test('has a heading, a labelled words field and the two buttons, and no camera control', async () => {
  const { fixture } = await render(async () => ({ status: 'no-device' }))
  const element = elementOf(fixture)
  expect(element.querySelector('h2')?.textContent).toBe('Restore songs')
  expect(element.querySelector('textarea')?.getAttribute('autocomplete')).toBe('off')
  expect(element.querySelector('textarea')?.getAttribute('spellcheck')).toBe('false')
  expect(element.querySelector('label')?.textContent).toContain('Recovery words')
  expect([...element.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
    'Choose song files',
    'Restore the songs',
  ])
  expect(element.querySelector('input[capture]')).toBeNull()
  expect(element.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.lyre')
  expect(element.querySelector('input[type=file]')?.hasAttribute('multiple')).toBe(true)
})

test('counts the chosen files', async () => {
  const { fixture } = await render(async () => ({ status: 'no-device' }))
  await chooseFiles(fixture, ['a.lyre'])
  expect(elementOf(fixture).textContent).toContain('1 song file chosen.')
  await chooseFiles(fixture, ['a.lyre', 'b.lyre'])
  expect(elementOf(fixture).textContent).toContain('2 song files chosen.')
})

test('empties the words field at the press and gives the restorer the words and the files', async () => {
  const restore = vi.fn(async () => ({ status: 'no-device' }) as RestoreOutcome)
  const { fixture } = await render(restore)
  await chooseFiles(fixture, ['a.lyre', 'b.lyre'])
  field(fixture).value = WORDS
  await press(fixture, 'Restore the songs')
  expect(field(fixture).value).toBe('')
  expect(restore).toHaveBeenCalledTimes(1)
  const [words, files] = restore.mock.calls[0] as unknown as [string, File[]]
  expect(words).toBe(WORDS)
  expect(files.map((f) => f.name)).toEqual(['a.lyre', 'b.lyre'])
  expect(elementOf(fixture).textContent).not.toContain('alpha')
})

test('shows one alert when the words are refused, and no list', async () => {
  const { fixture, kept } = await render(async () => ({ status: 'words-refused' }))
  field(fixture).value = WORDS
  await press(fixture, 'Restore the songs')
  expect(alerts(fixture)).toEqual(['These are not the 24 words of a recovery key. Check each word and try again.'])
  expect(elementOf(fixture).querySelector('ul')).toBeNull()
  expect(kept).not.toHaveBeenCalled()
})

test('shows one alert when the device could not be unlocked', async () => {
  const { fixture } = await render(async () => ({ status: 'no-device' }))
  await press(fixture, 'Restore the songs')
  expect(alerts(fixture)).toEqual(['This device could not be unlocked, so no song was restored.'])
})

test('lists each file as restored or not restored, with no alert', async () => {
  const { fixture } = await render(async () => ({
    status: 'done',
    keptKey: false,
    results: [
      { name: 'a.lyre', restored: true },
      { name: 'b.lyre', restored: false },
    ],
  }))
  await press(fixture, 'Restore the songs')
  const items = [...elementOf(fixture).querySelectorAll('ul[aria-label="Restore results"] li')].map((li) =>
    li.textContent?.trim(),
  )
  expect(items).toEqual(['a.lyre: restored', 'b.lyre: not restored. This file does not open with this recovery key.'])
  expect(alerts(fixture)).toEqual([])
})

test('fires keyKept only when the restore kept the key', async () => {
  const done = (keptKey: boolean): RestoreOutcome => ({ status: 'done', results: [], keptKey })
  const kept = await render(async () => done(true))
  await press(kept.fixture, 'Restore the songs')
  expect(kept.kept).toHaveBeenCalledTimes(1)
  TestBed.resetTestingModule()
  const notKept = await render(async () => done(false))
  await press(notKept.fixture, 'Restore the songs')
  expect(notKept.kept).not.toHaveBeenCalled()
})

test('disables both buttons while it restores', async () => {
  let finish: (outcome: RestoreOutcome) => void = () => undefined
  const { fixture } = await render(() => new Promise((resolve) => (finish = resolve)))
  await press(fixture, 'Restore the songs')
  const buttons = [...elementOf(fixture).querySelectorAll('button')]
  expect(buttons.every((b) => b.disabled)).toBe(true)
  expect(elementOf(fixture).textContent).toContain('Restoring the songs…')
  finish({ status: 'done', results: [], keptKey: false })
  await new Promise((resolve) => setTimeout(resolve))
  await fixture.whenStable()
  expect([...elementOf(fixture).querySelectorAll('button')].every((b) => !b.disabled)).toBe(true)
})
