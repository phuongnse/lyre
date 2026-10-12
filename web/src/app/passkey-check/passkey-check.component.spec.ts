import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { expect, test } from 'vitest'
import { PasskeyCheck } from './passkey-check.component'
import { Outcome, PASSKEY_CHECK } from './passkey-check'

// Renders the page with a check that gives `outcome`, then runs the check.
async function runWith(outcome: Outcome): Promise<HTMLElement> {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: PASSKEY_CHECK, useValue: () => Promise.resolve(outcome) }],
  })
  const fixture = TestBed.createComponent(PasskeyCheck)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  element.querySelector('button')?.click()
  await fixture.whenStable()
  return element
}

const status = (element: HTMLElement) => element.querySelector('[role="status"]')?.textContent?.trim()

test.each<[Outcome, string, string[]]>([
  [
    { result: 'works', flags: { eligible: false, state: false } },
    'Works: this device-bound passkey returned a PRF output.',
    ['Backup eligible: no', 'Backed up: no'],
  ],
  [
    { result: 'refused-sync', flags: { eligible: true, state: true } },
    'Refused: this passkey can sync to other devices.',
    ['Backup eligible: yes', 'Backed up: yes'],
  ],
  [
    { result: 'prf-missing', flags: { eligible: false, state: false } },
    'PRF missing: this passkey returned no PRF output.',
    ['Backup eligible: no', 'Backed up: no'],
  ],
])('reports the %j outcome', async (outcome, text, flagLines) => {
  const element = await runWith(outcome)
  expect(status(element)).toBe(text)
  for (const line of flagLines) expect(element.textContent).toContain(line)
})

test('reports only the error name when the check fails, without backup flags', async () => {
  const element = await runWith({ result: 'failed', errorName: 'NotAllowedError' })
  expect(status(element)).toBe('The check could not finish: NotAllowedError.')
  expect(element.textContent).not.toContain('Backup eligible')
  expect(element.textContent).not.toContain('Backed up')
})

test('shows the browser and the passkey it leaves behind before the check', async () => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: PASSKEY_CHECK, useValue: () => new Promise(() => {}) }],
  })
  const fixture = TestBed.createComponent(PasskeyCheck)
  await fixture.whenStable()
  const element = fixture.nativeElement as HTMLElement
  expect(element.textContent).toContain(navigator.userAgent)
  expect(element.textContent).toContain('Lyre passkey check')
  expect(status(element)).toBe('')

  element.querySelector('button')?.click()
  await fixture.whenStable()
  expect(status(element)).toBe('Checking…')
  expect(element.querySelector('button')?.disabled).toBe(true)
})
