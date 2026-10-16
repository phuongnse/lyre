import { expect, Page } from '@playwright/test'

declare global {
  interface Window {
    // The PRF output the authenticator returned, copied before the page wipes it.
    __testPrf?: number[]
  }
}

export type Authenticator = { hasPrf: boolean; backupEligible: boolean }

// Opens `path` with a virtual platform authenticator, and returns the text of
// every console message the page writes.
export async function openWith(page: Page, path: string, { hasPrf, backupEligible }: Authenticator): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
      defaultBackupEligibility: backupEligible,
      defaultBackupState: false,
    },
  })
  await page.addInitScript(() => {
    const original = PublicKeyCredential.prototype.getClientExtensionResults
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      const results = original.call(this)
      const first = results.prf?.results?.first
      if (first !== undefined) {
        const bytes = ArrayBuffer.isView(first)
          ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
          : new Uint8Array(first)
        window.__testPrf = Array.from(bytes)
      }
      return results
    }
  })
  const messages: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  await page.goto(path)
  return messages
}

// The PRF output the authenticator returned, or undefined when it returned none.
export async function returnedPrf(page: Page): Promise<number[] | undefined> {
  return page.evaluate(() => window.__testPrf)
}

// Every common encoding of the PRF output.
export function encodingsOf(output: number[]): string[] {
  const bytes = Buffer.from(output)
  return [
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    output.join(','),
  ]
}

// Checks that none of the `encodings` is in the page text, its HTML or a console message.
export async function expectNotInPage(page: Page, consoleMessages: string[], encodings: string[]): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText)
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  for (const encoding of encodings) {
    expect(text).not.toContain(encoding)
    expect(html).not.toContain(encoding)
    for (const message of consoleMessages) expect(message).not.toContain(encoding)
  }
}
