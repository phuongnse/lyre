import init, { coreVersion } from './lyre-wasm/lyre_wasm.js'

// React StrictMode runs effects twice, so the module is initialised only once.
let ready: Promise<unknown> | undefined

export async function loadCoreVersion(): Promise<string> {
  ready ??= init()
  await ready
  return coreVersion()
}
