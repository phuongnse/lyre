import { provideZonelessChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { expect, test } from 'vitest'
import { CORE_VERSION_LOADER } from '../core'
import { CoreVersion } from './core-version.component'

async function render(loader: () => Promise<string>): Promise<HTMLElement> {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: CORE_VERSION_LOADER, useValue: () => loader() }],
  })
  const fixture = TestBed.createComponent(CoreVersion)
  await fixture.whenStable()
  return fixture.nativeElement as HTMLElement
}

test('shows the version the loader returns', async () => {
  const element = await render(() => Promise.resolve('9.9.9'))
  expect(element.textContent?.trim()).toBe('Lyre core 9.9.9')
})

test('shows a plain message, without details, when the loader fails', async () => {
  const element = await render(() => Promise.reject(new Error('secret details')))
  expect(element.textContent?.trim()).toBe('Could not load the Lyre core.')
  expect(element.textContent).not.toContain('secret details')
})
