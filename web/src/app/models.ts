import { Injectable, InjectionToken, inject, signal } from '@angular/core'
import { loadCore } from '../core'
import { loadModel, ModelProgress } from '../models/model-download'
import { ModelFiles, opfsModelFiles } from '../models/model-files'

// Components get the model files' storage by injection, so tests can replace it.
export const MODEL_FILES = new InjectionToken<ModelFiles>('MODEL_FILES', {
  providedIn: 'root',
  factory: opfsModelFiles,
})

// The pinned model files on this device: each is downloaded on first use,
// checked by the core and kept, and checked again each time it is loaded.
@Injectable({ providedIn: 'root' })
export class Models {
  private readonly files = inject(MODEL_FILES)
  private readonly progressValue = signal<ModelProgress | undefined>(undefined)
  private readonly mayBeClearedFlag = signal(false)
  // The bytes downloaded so far, while a load downloads and after it ends.
  readonly progress = this.progressValue.asReadonly()
  // True once the browser has refused persistent storage before a download.
  readonly mayBeCleared = this.mayBeClearedFlag.asReadonly()

  // The checked model file `id`. It throws ModelCheckFailed or
  // ModelDownloadFailed, and never gives a file that failed its check.
  async load(id: string): Promise<Blob> {
    this.progressValue.set(undefined)
    await loadCore()
    return loadModel(id, {
      files: this.files,
      // Called through a function, because fetch needs the window as `this`.
      fetch: (input, init) => fetch(input, init),
      baseUri: document.baseURI,
      onProgress: (progress) => this.progressValue.set(progress),
      onMayBeCleared: () => this.mayBeClearedFlag.set(true),
    })
  }
}
