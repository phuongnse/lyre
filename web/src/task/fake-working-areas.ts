import { WorkingArea, WorkingAreas } from './working-area'

// In-memory working areas for tests. `areas` maps each task ID to its files.
export class FakeWorkingAreas implements WorkingAreas {
  readonly areas = new Map<string, Map<string, Blob>>()

  async create(taskId: string): Promise<WorkingArea> {
    const files = this.areas.get(taskId) ?? new Map<string, Blob>()
    this.areas.set(taskId, files)
    return {
      async write(name, data) {
        files.set(name, new Blob([data]))
      },
      async read(name) {
        const file = files.get(name)
        if (file === undefined) throw new DOMException(name, 'NotFoundError')
        return file
      },
    }
  }

  async remove(taskId: string): Promise<void> {
    this.areas.delete(taskId)
  }

  async removeAll(): Promise<void> {
    this.areas.clear()
  }
}
