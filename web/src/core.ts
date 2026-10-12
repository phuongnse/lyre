import { InjectionToken } from '@angular/core'
import init, { coreVersion } from './lyre-wasm/lyre_wasm.js'

// Every caller shares one initialisation of the WebAssembly module.
let ready: Promise<unknown> | undefined

export async function loadCoreVersion(): Promise<string> {
  // The build copies the module to lyre-wasm/. Resolving it against the document
  // keeps it loading when the site is served from a sub-path such as /lyre/.
  ready ??= init({ module_or_path: new URL('lyre-wasm/lyre_wasm_bg.wasm', document.baseURI) })
  await ready
  return coreVersion()
}

// Components get the loader by injection, so tests can replace it.
export const CORE_VERSION_LOADER = new InjectionToken<() => Promise<string>>('CORE_VERSION_LOADER', {
  providedIn: 'root',
  factory: () => loadCoreVersion,
})
