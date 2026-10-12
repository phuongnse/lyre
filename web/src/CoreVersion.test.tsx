import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { CoreVersion } from './CoreVersion'

afterEach(cleanup)

test('shows the version the loader returns', async () => {
  render(<CoreVersion loadVersion={() => Promise.resolve('9.9.9')} />)
  expect(await screen.findByText('Lyre core 9.9.9')).toBeTruthy()
})

test('shows a plain message, without details, when the loader fails', async () => {
  render(<CoreVersion loadVersion={() => Promise.reject(new Error('secret details'))} />)
  expect(await screen.findByText('Could not load the Lyre core.')).toBeTruthy()
  expect(screen.queryByText(/secret details/)).toBeNull()
})
