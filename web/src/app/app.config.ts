import { ApplicationConfig, inject, provideAppInitializer, provideZonelessChangeDetection } from '@angular/core'
import { provideRouter, withHashLocation } from '@angular/router'
import { removeLeftWorkingAreas } from '../task/working-area'
import { routes } from './app.routes'
import { WORKING_AREAS } from './working-areas'

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Hash URLs, so deep links work on GitHub Pages, which cannot rewrite them to index.html.
    provideRouter(routes, withHashLocation()),
    // Removes the working area of a task that stopped with the page. It does
    // not wait for the cleanup, so the app starts at once.
    provideAppInitializer(() => {
      void removeLeftWorkingAreas(inject(WORKING_AREAS))
    }),
  ],
}
