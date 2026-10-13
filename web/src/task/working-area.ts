// A task's working area: the folder where its stages write their output
// (docs/architecture.md#processing). The web client keeps each one in the
// browser's origin private file system (OPFS), as tasks/<task ID>/, because
// later stages write large audio files and one call removes a whole folder.
// This file runs on the page and in the task's worker, so it uses only types
// that both have.

export interface WorkingArea {
  // Writes `data` to the file `name`, replacing it.
  write(name: string, data: Blob | BufferSource): Promise<void>
  read(name: string): Promise<Blob>
}

export interface WorkingAreas {
  // Creates the working area of `taskId`, or opens it when it exists.
  create(taskId: string): Promise<WorkingArea>
  // Removes the working area of `taskId`. Resolves when it is gone, also when it never existed.
  remove(taskId: string): Promise<void>
  // Removes every working area.
  removeAll(): Promise<void>
}

// The lock a task holds for its whole run, so one task runs at a time across
// tabs and the startup cleanup never removes the area of a running task.
export const TASK_LOCK = 'lyre-task'

const TASKS = 'tasks'
const REMOVE_TRIES = 5
const REMOVE_RETRY_MS = 100

const isNotFound = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError'

// Removes `name` from `parent`, trying again a few times: Chromium may keep a
// file locked for a moment after the worker that wrote it ends.
async function removeEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await parent.removeEntry(name, { recursive: true })
      return
    } catch (error) {
      if (isNotFound(error)) return
      if (attempt >= REMOVE_TRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS))
    }
  }
}

export function opfsWorkingAreas(): WorkingAreas {
  const tasks = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(TASKS, { create: true })
  return {
    async create(taskId) {
      const folder = await (await tasks()).getDirectoryHandle(taskId, { create: true })
      return {
        async write(name, data) {
          const file = await folder.getFileHandle(name, { create: true })
          const stream = await file.createWritable()
          try {
            await stream.write(data)
          } finally {
            await stream.close()
          }
        },
        async read(name) {
          return (await folder.getFileHandle(name)).getFile()
        },
      }
    },
    async remove(taskId) {
      await removeEntry(await tasks(), taskId)
    },
    async removeAll() {
      await removeEntry(await navigator.storage.getDirectory(), TASKS)
    },
  }
}

// Removes the working areas left by a page that closed during a task. It
// waits for the task lock, which a closing page may still hold for a moment,
// so it never removes the area of a task that is still running. Like the
// library, it neither shows nor logs a storage error.
export async function removeLeftWorkingAreas(areas: WorkingAreas): Promise<void> {
  // Some environments, such as jsdom, have neither.
  if (!navigator.locks || !navigator.storage?.getDirectory) return
  try {
    await navigator.locks.request(TASK_LOCK, () => areas.removeAll())
  } catch {
    // Some browsers block OPFS, for example in private windows.
  }
}
