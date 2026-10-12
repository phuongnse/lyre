import { CoreVersion } from './CoreVersion'
import { loadCoreVersion } from './core'

export function App() {
  return (
    <>
      <h1>Lyre</h1>
      <CoreVersion loadVersion={loadCoreVersion} />
    </>
  )
}
