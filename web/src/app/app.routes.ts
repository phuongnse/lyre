import { Routes } from '@angular/router'
import { Home } from './home.component'

export const routes: Routes = [
  { path: '', component: Home },
  // A check page loads its code only when it opens (docs/ui-conventions.md#check-pages).
  {
    path: 'passkey-check',
    loadComponent: () => import('./passkey-check/passkey-check.component').then((m) => m.PasskeyCheck),
  },
  { path: '**', redirectTo: '' },
]
