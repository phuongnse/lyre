import { describe, expect, test } from 'vitest'
import { describeDevice } from './device'

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

describe('the device from what the browser reports', () => {
  test('Chrome on Android names the brand, the full version and the platform version from the client hints', () => {
    const device = describeDevice({
      userAgent: CHROME_ANDROID,
      uaData: {
        platform: 'Android',
        platformVersion: '14.0.0',
        brands: [
          { brand: 'Not.A/Brand', version: '99' },
          { brand: 'Chromium', version: '141' },
          { brand: 'Google Chrome', version: '141' },
        ],
        fullVersionList: [
          { brand: 'Not.A/Brand', version: '99.0.0.0' },
          { brand: 'Chromium', version: '141.0.7390.37' },
          { brand: 'Google Chrome', version: '141.0.7390.37' },
        ],
      },
      adapterInfo: { vendor: 'qualcomm', architecture: 'adreno-7xx', device: '', description: 'Adreno 740' },
    })
    expect(device).toEqual({
      browser: 'Google Chrome 141.0.7390.37',
      os: 'Android 14.0.0',
      webgpu: true,
      vendor: 'qualcomm',
      architecture: 'adreno-7xx',
      description: 'Adreno 740',
    })
  })

  test('a Chromium-only brand list gives Chromium', () => {
    const device = describeDevice({
      userAgent: CHROME_ANDROID,
      uaData: { platform: 'Linux', brands: [{ brand: 'Chromium', version: '141' }] },
    })
    expect(device.browser).toBe('Chromium 141')
    expect(device.os).toBe('Linux')
  })

  test('Firefox on Windows comes from the user agent, and has no GPU without an adapter', () => {
    expect(describeDevice({ userAgent: FIREFOX_WINDOWS })).toEqual({
      browser: 'Firefox 128.0',
      os: 'Windows 10.0',
      webgpu: false,
      vendor: undefined,
      architecture: undefined,
      description: undefined,
    })
  })

  test('Safari on iPhone gives the iOS version with dots', () => {
    const device = describeDevice({ userAgent: SAFARI_IPHONE })
    expect(device.browser).toBe('Safari 17.5')
    expect(device.os).toBe('iOS 17.5')
  })

  test('a user agent it cannot parse gives no browser and no OS', () => {
    const device = describeDevice({ userAgent: 'something else entirely' })
    expect(device.browser).toBeUndefined()
    expect(device.os).toBeUndefined()
  })

  test('an empty adapter description is not reported, and the adapter still means WebGPU is available', () => {
    const device = describeDevice({
      userAgent: FIREFOX_WINDOWS,
      adapterInfo: { vendor: 'test-vendor', architecture: '', device: '', description: '' },
    })
    expect(device.webgpu).toBe(true)
    expect(device.vendor).toBe('test-vendor')
    expect(device.architecture).toBeUndefined()
    expect(device.description).toBeUndefined()
  })
})
