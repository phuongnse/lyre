import { provideZonelessChangeDetection } from '@angular/core'
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { afterEach, expect, test, vi } from 'vitest'
import { DeviceCode } from './device-code.component'
import { DEVICE_UNLOCK, DeviceOutcome } from './device-passkey'

const CODE = 'lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara'

// A 3 by 3 symbol with its four corners dark.
const ready: DeviceOutcome = {
  result: 'ready',
  deviceCode: CODE,
  fingerprint: '1458 7998 1818 4050 3333',
  qr: { size: 3, modules: Uint8Array.from([1, 0, 1, 0, 0, 0, 1, 0, 1]) },
}

afterEach(() => vi.unstubAllGlobals())

// Renders the section with an unlock that gives `outcome`, then presses the button.
async function pressWith(outcome: DeviceOutcome): Promise<ComponentFixture<DeviceCode>> {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: DEVICE_UNLOCK, useValue: () => Promise.resolve(outcome) }],
  })
  const fixture = TestBed.createComponent(DeviceCode)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  expect(element.querySelector('section')?.getAttribute('aria-labelledby')).toBe('this-device-heading')
  expect(element.querySelector('h2')?.textContent).toBe('This device')
  element.querySelector('button')?.click()
  await fixture.whenStable()
  return fixture
}

const elementOf = (fixture: ComponentFixture<DeviceCode>) => fixture.nativeElement as HTMLElement

const status = (element: HTMLElement) => element.querySelector('[role="status"]')?.textContent?.trim()

test('shows nothing but the button before it is pressed', () => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: DEVICE_UNLOCK, useValue: () => new Promise(() => {}) }],
  })
  const element = TestBed.createComponent(DeviceCode).nativeElement as HTMLElement
  expect(element.querySelectorAll('button')).toHaveLength(1)
  expect(element.querySelector('dl, svg')).toBeNull()
})

test('shows the code, the fingerprint, the QR code and the copy button when ready', async () => {
  const element = elementOf(await pressWith(ready))
  expect(element.querySelector('dl')?.textContent).toContain(CODE)
  expect(element.querySelector('dl')?.textContent).toContain('1458 7998 1818 4050 3333')
  const svg = element.querySelector('svg')
  expect(svg?.getAttribute('role')).toBe('img')
  expect(svg?.getAttribute('aria-label')).toBe('QR code of the device code')
  // 3 modules and a quiet zone of 4 on each side.
  expect(svg?.getAttribute('viewBox')).toBe('0 0 11 11')
  expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M4 4h1v1h-1zM6 4h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1z')
  expect([...element.querySelectorAll('button')].map((b) => b.textContent?.trim())).toContain('Copy the device code')
})

test.each<[DeviceOutcome, string]>([
  [
    { result: 'prf-missing' },
    'This browser cannot give this device a device code, because its passkeys return no PRF output.',
  ],
  [{ result: 'refused-sync' }, 'This device gets no device code, because its passkey can sync to other devices.'],
  [{ result: 'failed' }, 'This device could not be unlocked, so it has no device code.'],
])('says why and shows no code for %j', async (outcome, text) => {
  const element = elementOf(await pressWith(outcome))
  expect(status(element)).toBe(text)
  expect(element.querySelector('dl, svg')).toBeNull()
  expect(element.querySelectorAll('button')).toHaveLength(1)
})

const copyButton = (element: HTMLElement) =>
  [...element.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy the device code'))

test('copies exactly the shown code and says so', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const fixture = await pressWith(ready)
  copyButton(elementOf(fixture))?.click()
  await fixture.whenStable()
  expect(writeText).toHaveBeenCalledExactlyOnceWith(CODE)
  expect(elementOf(fixture).textContent).toContain('The device code is copied.')
})

test.each([
  ['a write the browser refuses', { clipboard: { writeText: () => Promise.reject(new DOMException('no')) } }],
  ['a browser without a clipboard API', {}],
])('says the browser refused for %s', async (_name, stub) => {
  vi.stubGlobal('navigator', stub)
  const fixture = await pressWith(ready)
  copyButton(elementOf(fixture))?.click()
  await fixture.whenStable()
  expect(elementOf(fixture).textContent).toContain('The browser refused to copy the device code.')
  expect(elementOf(fixture).textContent).not.toContain('The device code is copied.')
})
