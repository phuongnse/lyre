import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core'
import { provideRouter, withHashLocation } from '@angular/router'
import { routes } from './app.routes'

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Hash URLs, so deep links work on GitHub Pages, which cannot rewrite them to index.html.
    provideRouter(routes, withHashLocation()),
  ],
}
