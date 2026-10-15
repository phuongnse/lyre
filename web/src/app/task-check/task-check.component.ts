import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { MatButton } from '@angular/material/button'
import { MatProgressBar } from '@angular/material/progress-bar'
import { secondsLeft, stagePercent, TaskRunner } from '../../task/task-runner'
import { messages } from '../messages'

// The task check page (docs/ui-conventions.md#check-pages). It runs a task of
// test stages, so cancel and cleanup are checked without a source or models.
// Opened by its URL, #/task-check.
@Component({
  selector: 'lyre-task-check',
  imports: [MatButton, MatProgressBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = state();
    <h2>{{ messages.taskCheckTitle }}</h2>
    <p>{{ messages.taskCheckAbout }}</p>
    <button matButton="filled" type="button" [disabled]="current.status === 'running'" (click)="runner.start()">
      {{ messages.startTestTask }}
    </button>
    <button matButton type="button" [disabled]="current.status !== 'running'" (click)="runner.cancel()">
      {{ messages.cancelTask }}
    </button>
    <mat-progress-bar mode="determinate" [value]="percent()" [attr.aria-label]="messages.taskProgress" />
    <p role="status">
      @switch (current.status) {
        @case ('running') {
          @if (current.report; as report) {
            {{ messages.taskStage(report.index + 1, report.count, stageName(report.stage)) }}
          }
        }
        @case ('done') {
          {{ messages.taskDone }}
        }
        @case ('cancelled') {
          {{ messages.taskCancelled }}
        }
        @case ('failed') {
          @if (current.stage) {
            {{ messages.taskFailedIn(stageName(current.stage), messages.taskFailures[current.reason]) }}
          } @else {
            {{ messages.taskFailed(messages.taskFailures[current.reason]) }}
          }
        }
      }
    </p>
    <!-- Outside the status line, so a screen reader does not announce each update. -->
    @if (secondsLeft(); as seconds) {
      <p>{{ messages.taskTimeLeft(seconds) }}</p>
    }
  `,
})
export class TaskCheck {
  protected readonly messages = messages
  protected readonly runner = inject(TaskRunner)
  protected readonly state = this.runner.state
  protected readonly percent = computed(() => stagePercent(this.state()))
  protected readonly secondsLeft = computed(() => secondsLeft(this.state()))

  protected stageName(stage: string): string {
    return (messages.stageNames as Record<string, string | undefined>)[stage] ?? stage
  }
}
