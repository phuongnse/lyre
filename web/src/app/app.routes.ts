import { Routes } from '@angular/router'
import { Home } from './home.component'

export const routes: Routes = [
  { path: '', component: Home },
  // A check page loads its code only when it opens (docs/ui-conventions.md#check-pages).
  {
    path: 'passkey-check',
    loadComponent: () => import('./passkey-check/passkey-check.component').then((m) => m.PasskeyCheck),
  },
  {
    path: 'task-check',
    loadComponent: () => import('./task-check/task-check.component').then((m) => m.TaskCheck),
  },
  {
    path: 'source-check',
    loadComponent: () => import('./source-check/source-check.component').then((m) => m.SourceCheck),
  },
  {
    path: 'model-check',
    loadComponent: () => import('./model-check/model-check.component').then((m) => m.ModelCheckPage),
  },
  {
    path: 'separation-check',
    loadComponent: () => import('./separation-check/separation-check.component').then((m) => m.SeparationCheck),
  },
  { path: '**', redirectTo: '' },
]
