import { adapterFound } from '../gpu'

// What a device needs to make songs (docs/decisions.md#d25-requirements-for-making-songs--agreed).
export type Requirement = 'webgpu' | 'memory'

// The least memory, in GB, as the browser reports it.
export const MIN_MEMORY_GB = 8

// The requirements the device does not meet. A browser that does not report
// its memory passes the memory check.
export function unmetRequirements(device: { adapterFound: boolean; memoryGb?: number }): Requirement[] {
  const unmet: Requirement[] = []
  if (!device.adapterFound) unmet.push('webgpu')
  if (device.memoryGb !== undefined && device.memoryGb < MIN_MEMORY_GB) unmet.push('memory')
  return unmet
}

// Reads the device from the browser. `navigator.deviceMemory` is the only
// memory figure browsers give: it is rounded, and Chromium caps it at 8.
export async function readRequirements(): Promise<Requirement[]> {
  const memoryGb = (navigator as { deviceMemory?: number }).deviceMemory
  return unmetRequirements({ adapterFound: await adapterFound(), memoryGb })
}
