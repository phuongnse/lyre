import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RecoveryKey } from './recovery-key.component'
import { NewRecovery, RECOVERY_KEY_MAKER, recoveryKeyStorageKey } from './recovery-key'

const words = Array.from({ length: 24 }, (_, i) => `word${String.fromCharCode(97 + i)}`)

// A 3 by 3 symbol with its four corners dark.
const made: NewRecovery = {
  words,
  qr: { size: 3, modules: Uint8Array.from([1, 0, 1, 0, 0, 0, 1, 0, 1]) },
  publicKey: new Uint8Array(33).fill(2),
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

async function render(make: () => Promise<NewRecovery> = () => Promise.resolve(made)) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: RECOVERY_KEY_MAKER, useValue: make }],
  })
  const fixture = TestBed.createComponent(RecoveryKey)
  await fixture.whenStable()
  return fixture
}

const elementOf = (fixture: ComponentFixture<RecoveryKey>) => fixture.nativeElement as HTMLElement

const press = async (fixture: ComponentFixture<RecoveryKey>, name: string) => {
  const button = [...elementOf(fixture).querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  expect(button).toBeDefined()
  button!.click()
  await fixture.whenStable()
}

const LOSS = 'If you lose every device and your recovery key, your songs cannot be opened again.'

test('offers to create a key and warns about losing it', async () => {
  const element = elementOf(await render())
  expect(element.querySelector('h2')?.textContent).toBe('Recovery key')
  expect(element.querySelector('section')?.getAttribute('aria-labelledby')).toBe('recovery-key-heading')
  expect(element.querySelector('button')?.textContent?.trim()).toBe('Create a recovery key')
  expect(element.textContent).toContain(LOSS)
  expect(element.querySelector('ol')).toBeNull()
})

test('shows the words as a numbered list and the QR code, and keeps nothing yet', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  const element = elementOf(fixture)
  expect(element.querySelector('ol')?.getAttribute('aria-label')).toBe('Recovery words')
  expect([...element.querySelectorAll('li')].map((li) => li.textContent)).toEqual(words)
  const svg = element.querySelector('svg')
  expect(svg?.getAttribute('role')).toBe('img')
  expect(svg?.getAttribute('aria-label')).toBe('QR code of the recovery key')
  expect(svg?.getAttribute('viewBox')).toBe('0 0 11 11')
  expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M4 4h1v1h-1zM6 4h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1z')
  expect(element.textContent).toContain(LOSS)
  expect(localStorage.getItem(recoveryKeyStorageKey)).toBeNull()
})

test('confirming keeps only the public key and drops the words and the QR code', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  await press(fixture, 'I have kept my recovery key')
  const element = elementOf(fixture)
  expect(element.querySelector('ol')).toBeNull()
  expect(element.querySelector('svg')).toBeNull()
  expect(element.querySelector('button')).toBeNull()
  expect(element.textContent).toContain(
    "This device keeps your recovery key's public part. Every song you make can be recovered with your recovery key.",
  )
  expect(element.textContent).toContain(LOSS)
  expect(localStorage.length).toBe(1)
  expect(localStorage.getItem(recoveryKeyStorageKey)).toMatch(/^[A-Za-z0-9_-]{44}$/)
})

test('starts as kept, with no create button, when a key is stored', async () => {
  localStorage.setItem(recoveryKeyStorageKey, 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC')
  const element = elementOf(await render())
  expect(element.querySelector('button')).toBeNull()
  expect(element.textContent).toContain('This device keeps your recovery key')
})

test('says so, with the create button again, when the storage refuses the key', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'QuotaExceededError')
  })
  await press(fixture, 'I have kept my recovery key')
  const element = elementOf(fixture)
  expect(element.querySelector('[role="alert"]')?.textContent).toBe(
    'The recovery key could not be kept on this device.',
  )
  expect(element.querySelector('ol')).toBeNull()
  expect(element.querySelector('svg')).toBeNull()
  expect(element.querySelector('button')?.textContent?.trim()).toBe('Create a recovery key')
  vi.restoreAllMocks()
})

test('an error from making the key shows the alert without its text', async () => {
  const fixture = await render(() => Promise.reject(new Error('secret detail')))
  await press(fixture, 'Create a recovery key')
  const element = elementOf(fixture)
  expect(element.querySelector('[role="alert"]')?.textContent).toBe(
    'The recovery key could not be kept on this device.',
  )
  expect(element.textContent).not.toContain('secret detail')
  expect(element.querySelector('button')?.textContent?.trim()).toBe('Create a recovery key')
})

// The words and the QR code must leave every field of the component, not just
// the page, so nothing keeps them reachable.
const stateOf = (fixture: ComponentFixture<RecoveryKey>) =>
  JSON.stringify((fixture.componentInstance as unknown as { state: () => object }).state())

test('the component holds the words only while they are shown', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  expect(stateOf(fixture)).toContain(words[0])
  await press(fixture, 'I have kept my recovery key')
  expect(stateOf(fixture)).not.toContain(words[0])
  expect(JSON.stringify(Object.values(fixture.componentInstance as object))).not.toContain(words[0])
  expect(JSON.stringify(Object.values(fixture.componentInstance as object))).not.toContain('h1v1h-1z')
})

test('the component drops the words when the storage refuses the key', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'QuotaExceededError')
  })
  await press(fixture, 'I have kept my recovery key')
  vi.restoreAllMocks()
  expect(JSON.stringify(Object.values(fixture.componentInstance as object))).not.toContain(words[0])
  expect(stateOf(fixture)).not.toContain(words[0])
})

test('a second tab that confirms later does not replace the first tab’s key', async () => {
  let count = 0
  const first = await render(() => Promise.resolve({ ...made, publicKey: new Uint8Array(33).fill(++count + 1) }))
  const second = TestBed.createComponent(RecoveryKey)
  await second.whenStable()
  await press(first, 'Create a recovery key')
  await press(second, 'Create a recovery key')
  await press(first, 'I have kept my recovery key')
  const kept = localStorage.getItem(recoveryKeyStorageKey)
  expect(kept).toMatch(/^[A-Za-z0-9_-]{44}$/)
  await press(second, 'I have kept my recovery key')
  expect(localStorage.getItem(recoveryKeyStorageKey)).toBe(kept)
  const element = elementOf(second)
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('Another tab already kept a recovery key')
  expect(element.querySelector('ol')).toBeNull()
  expect(element.querySelector('svg')).toBeNull()
  expect(JSON.stringify(Object.values(second.componentInstance as object))).not.toContain(words[0])
})

test('a tab that shows words drops them when another tab keeps a key', async () => {
  const fixture = await render()
  await press(fixture, 'Create a recovery key')
  localStorage.setItem(recoveryKeyStorageKey, 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD')
  window.dispatchEvent(new StorageEvent('storage', { key: recoveryKeyStorageKey }))
  await fixture.whenStable()
  const element = elementOf(fixture)
  expect(element.querySelector('ol')).toBeNull()
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('Another tab already kept a recovery key')
  expect(stateOf(fixture)).not.toContain(words[0])
})
