// The part of Trusted Types this file uses. lib.dom does not declare it yet.
type TrustedTypes = {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown }
}

// A policy name can be created only once per page, so every worker shares this one.
let workerPolicy: ReturnType<TrustedTypes['createPolicy']> | undefined

// The page requires Trusted Types for scripts, so a worker's URL must come
// from a policy. This one, listed in index.html, allows only this origin.
export function trustedScriptUrl(url: URL): URL {
  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes
  if (trustedTypes === undefined) return url
  workerPolicy ??= trustedTypes.createPolicy('lyre#worker', {
    createScriptURL(href) {
      if (new URL(href).origin !== location.origin) throw new TypeError('A worker must come from this origin')
      return href
    },
  })
  // The browser takes a TrustedScriptURL wherever it takes a URL.
  return workerPolicy.createScriptURL(url.href) as URL
}
