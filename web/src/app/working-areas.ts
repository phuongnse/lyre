import { InjectionToken } from '@angular/core'
import { opfsWorkingAreas, WorkingAreas } from '../task/working-area'

// The page gets the tasks' storage by injection, so tests can replace it. It
// lives apart from the task runner, so the startup cleanup does not pull the
// runner and its worker into the main app's initial load.
export const WORKING_AREAS = new InjectionToken<WorkingAreas>('WORKING_AREAS', {
  providedIn: 'root',
  factory: opfsWorkingAreas,
})
