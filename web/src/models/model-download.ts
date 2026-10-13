// Downloads, checks and keeps the pinned model files (docs/architecture.md#overview).
// A file is downloaded in pieces, and each piece goes to the core's check and
// to storage, so the whole file is never in memory. A file is kept only when
// it passes, and it is checked again each time it is loaded, because nothing
// authenticates the browser's storage. A file that fails is never returned.
// The core must be loaded first.
import { ModelCheck, pinnedFiles } from '../lyre-wasm/lyre_wasm.js'
import { ModelFiles, ModelWriter } from './model-files'

// The model file `id` failed its check against its pinned size and SHA-256. It was deleted.
export class ModelCheckFailed extends Error {
  constructor(readonly id: string) {
    super(`The model file ${id} failed its check.`)
    this.name = 'ModelCheckFailed'
  }
}

// The model file `id` could not be downloaded or stored. Nothing was kept.
export class ModelDownloadFailed extends Error {
  constructor(readonly id: string) {
    super(`The model file ${id} could not be downloaded.`)
    this.name = 'ModelDownloadFailed'
  }
}

export interface ModelProgress {
  id: string
  loadedBytes: number
  totalBytes: number
}

export interface ModelDeps {
  files: ModelFiles
  fetch: typeof fetch
  // What a test entry's relative URL is resolved against: the document's base URI.
  baseUri: string
  onProgress?: (progress: ModelProgress) => void
  // Called before a download when the browser does not grant persistent storage.
  onMayBeCleared?: () => void
}

interface Pinned {
  id: string
  url: string
  size: number
}

function pinned(id: string): Pinned {
  const files = pinnedFiles()
  try {
    const file = files.find((candidate) => candidate.id === id)
    if (!file) throw new Error(`There is no pinned model file ${id}.`)
    return { id: file.id, url: file.url, size: file.size }
  } finally {
    for (const file of files) file.free()
  }
}

function startCheck(id: string): ModelCheck {
  const check = ModelCheck.start(id)
  if (!check) throw new Error(`There is no pinned model file ${id}.`)
  return check
}

function passed(check: ModelCheck): boolean {
  const result = check.result()
  try {
    return result.passed
  } finally {
    result.free()
  }
}

// Whether the kept `file` passes the check of `id`, read piece by piece.
async function keptFilePasses(id: string, file: Blob): Promise<boolean> {
  const check = startCheck(id)
  try {
    const reader = file.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return passed(check)
      if (!check.feed(value)) {
        await reader.cancel()
        return false
      }
    }
  } finally {
    check.free()
  }
}

// Gives the checked model file `id`: the kept file when it still passes,
// otherwise a new download that passed. It throws ModelCheckFailed or
// ModelDownloadFailed, and never returns a file that failed.
export async function loadModel(id: string, deps: ModelDeps): Promise<Blob> {
  const file = pinned(id)
  const kept = await deps.files.get(id)
  if (kept) {
    if (await keptFilePasses(id, kept)) return kept
    await deps.files.remove(id)
  }
  // The client asks for persistent storage only when it is about to keep a model.
  if (!((await deps.files.persisted()) || (await deps.files.persist()))) deps.onMayBeCleared?.()
  return download(file, deps)
}

async function download(file: Pinned, deps: ModelDeps): Promise<Blob> {
  const { id, size } = file
  let response: Response
  try {
    // No cookies, no referrer and no headers: only the request for the file.
    response = await deps.fetch(new URL(file.url, deps.baseUri), {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    })
  } catch {
    throw new ModelDownloadFailed(id)
  }
  const body = response.body
  if (!response.ok || !body) {
    await body?.cancel().catch(() => undefined)
    throw new ModelDownloadFailed(id)
  }

  const check = startCheck(id)
  const reader = body.getReader()
  let writer: ModelWriter
  try {
    writer = await deps.files.create(id)
  } catch {
    check.free()
    await reader.cancel().catch(() => undefined)
    throw new ModelDownloadFailed(id)
  }
  try {
    let loadedBytes = 0
    deps.onProgress?.({ id, loadedBytes, totalBytes: size })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!check.feed(value)) {
        // Longer than the pinned size: it can no longer pass.
        await reader.cancel().catch(() => undefined)
        throw new ModelCheckFailed(id)
      }
      await writer.write(value)
      loadedBytes += value.byteLength
      deps.onProgress?.({ id, loadedBytes, totalBytes: size })
    }
    if (!passed(check)) throw new ModelCheckFailed(id)
    await writer.commit()
  } catch (error) {
    await writer.abort().catch(() => undefined)
    await deps.files.remove(id)
    throw error instanceof ModelCheckFailed ? error : new ModelDownloadFailed(id)
  } finally {
    check.free()
  }
  // The bytes just stored are the bytes the core just checked, so they are
  // not checked a second time until the next load.
  const stored = await deps.files.get(id)
  if (!stored) throw new ModelDownloadFailed(id)
  return stored
}
