// What the page reports about the device a measurement ran on, as the browser
// gives it. A field the browser does not give is left out.
export type Device = {
  browser?: string
  os?: string
  webgpu: boolean
  vendor?: string
  architecture?: string
  description?: string
}

// The part of the User-Agent Client Hints API this file uses. The TypeScript
// libraries do not declare it.
type UaData = {
  platform?: string
  brands?: { brand: string; version: string }[]
  platformVersion?: string
  fullVersionList?: { brand: string; version: string }[]
}

// The part of WebGPU this file uses. The TypeScript libraries do not declare it.
export type AdapterInfo = { vendor?: string; architecture?: string; device?: string; description?: string }
type Gpu = { requestAdapter(): Promise<{ info?: AdapterInfo } | null> }

const orUndefined = (text: string | undefined) => (text?.trim() ? text.trim() : undefined)

// The brand to show: any brand other than the placeholder one, preferring one
// other than Chromium, which every Chromium-based browser also lists.
function browserFromUaData({ brands, fullVersionList }: UaData): string | undefined {
  const list = (fullVersionList?.length ? fullVersionList : brands) ?? []
  const real = list.filter(({ brand }) => !/not.?a.?brand/i.test(brand))
  const chosen = real.find(({ brand }) => brand !== 'Chromium') ?? real[0]
  return chosen && orUndefined(`${chosen.brand} ${chosen.version}`)
}

function browserFromUserAgent(userAgent: string): string | undefined {
  const patterns: [RegExp, string][] = [
    [/Firefox\/(\S+)/, 'Firefox'],
    [/Edg\/(\S+)/, 'Edge'],
    [/Chrome\/(\S+)/, 'Chrome'],
    [/Version\/(\S+).*Safari/, 'Safari'],
  ]
  for (const [pattern, name] of patterns) {
    const version = pattern.exec(userAgent)?.[1]
    if (version) return `${name} ${version}`
  }
  return undefined
}

function osFromUserAgent(userAgent: string): string | undefined {
  const android = /Android ([\d.]+)/.exec(userAgent)
  if (android) return `Android ${android[1]}`
  const ios = /(?:iPhone|CPU) OS ([\d_]+)/.exec(userAgent)
  if (ios) return `iOS ${ios[1]!.replaceAll('_', '.')}`
  const mac = /Mac OS X ([\d_.]+)/.exec(userAgent)
  if (mac) return `macOS ${mac[1]!.replaceAll('_', '.')}`
  const windows = /Windows NT ([\d.]+)/.exec(userAgent)
  if (windows) return `Windows ${windows[1]}`
  if (userAgent.includes('CrOS')) return 'ChromeOS'
  if (userAgent.includes('Linux')) return 'Linux'
  return undefined
}

// The device from what the browser reports. WebGPU counts as available only
// when the browser gave an adapter: Chromium keeps navigator.gpu even with its
// GPU off. The OS is the platform and its version exactly as the browser
// gives them.
export function describeDevice(input: { userAgent: string; uaData?: UaData; adapterInfo?: AdapterInfo }): Device {
  const { userAgent, uaData, adapterInfo } = input
  const platform = orUndefined(uaData?.platform)
  return {
    browser: (uaData && browserFromUaData(uaData)) ?? browserFromUserAgent(userAgent),
    os: (platform && orUndefined(`${platform} ${uaData?.platformVersion ?? ''}`)) ?? osFromUserAgent(userAgent),
    webgpu: adapterInfo !== undefined,
    vendor: orUndefined(adapterInfo?.vendor),
    architecture: orUndefined(adapterInfo?.architecture),
    description: orUndefined(adapterInfo?.description),
  }
}

// Reads the device on the page's main thread.
export async function readDevice(): Promise<Device> {
  const uaData = (navigator as { userAgentData?: UaData & { getHighEntropyValues(hints: string[]): Promise<UaData> } })
    .userAgentData
  let detailed: UaData | undefined = uaData
  try {
    detailed = uaData && { ...uaData, ...(await uaData.getHighEntropyValues(['platformVersion', 'fullVersionList'])) }
  } catch {
    // The low-entropy fields stay.
  }
  let adapterInfo: AdapterInfo | undefined
  try {
    const adapter = await (navigator as { gpu?: Gpu }).gpu?.requestAdapter()
    // An adapter without info still means WebGPU runs.
    adapterInfo = adapter ? (adapter.info ?? {}) : undefined
  } catch {
    adapterInfo = undefined
  }
  return describeDevice({ userAgent: navigator.userAgent, uaData: detailed, adapterInfo })
}
