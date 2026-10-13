// Keeps the downloaded model files in the browser's origin private file system
// (OPFS), as models/<model file ID>. The browser may clear this storage unless
// it grants persistent storage, and nothing authenticates it, so a kept file is
// checked again each time it is loaded
// (docs/domain/knowledge.md#running-on-the-users-device).

// Writes one model file. Nothing written is kept until `commit` resolves. A
// download stopped by a closing page may leave an empty file, which fails its
// check on the next load and is removed then.
export interface ModelWriter {
  write(piece: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export interface ModelFiles {
  // The kept file `id`, or undefined when there is none.
  get(id: string): Promise<Blob | undefined>
  // Starts writing the file `id`. Committing it replaces a kept file.
  create(id: string): Promise<ModelWriter>
  // Removes the kept file `id`. Resolves when it is gone, also when it never existed.
  remove(id: string): Promise<void>
  // Whether the browser has granted persistent storage.
  persisted(): Promise<boolean>
  // Asks the browser for persistent storage. Resolves whether it is granted.
  persist(): Promise<boolean>
}

const MODELS = 'models'

const isNotFound = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError'

export function opfsModelFiles(): ModelFiles {
  const models = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(MODELS, { create: true })
  return {
    async get(id) {
      try {
        return await (await (await models()).getFileHandle(id)).getFile()
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
    async create(id) {
      const file = await (await models()).getFileHandle(id, { create: true })
      // Writes go to a swap file, which replaces the file only on close().
      const stream = await file.createWritable()
      return {
        write: (piece) => stream.write(piece as Uint8Array<ArrayBuffer>),
        commit: () => stream.close(),
        abort: () => stream.abort(),
      }
    },
    async remove(id) {
      try {
        await (await models()).removeEntry(id)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    },
    async persisted() {
      return (await navigator.storage?.persisted?.()) ?? false
    },
    async persist() {
      return (await navigator.storage?.persist?.()) ?? false
    },
  }
}
