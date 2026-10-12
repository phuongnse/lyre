// Every user-visible string lives here (docs/ui-conventions.md#strings).
// The text is still English. The Vietnamese text comes in a later issue.
export const messages = {
  appTitle: 'Lyre',
  coreLoading: 'Loading the Lyre core…',
  coreVersion: (version: string) => `Lyre core ${version}`,
  coreFailed: 'Could not load the Lyre core.',
} as const
