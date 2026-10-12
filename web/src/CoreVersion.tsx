import { useEffect, useState } from 'react'

type State = { status: 'loading' } | { status: 'ready'; version: string } | { status: 'failed' }

export function CoreVersion({ loadVersion }: { loadVersion: () => Promise<string> }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadVersion().then(
      (version) => {
        if (!cancelled) setState({ status: 'ready', version })
      },
      () => {
        if (!cancelled) setState({ status: 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [loadVersion])

  switch (state.status) {
    case 'loading':
      return <p>Loading the Lyre core…</p>
    case 'ready':
      return <p>Lyre core {state.version}</p>
    case 'failed':
      return <p>Could not load the Lyre core.</p>
  }
}
