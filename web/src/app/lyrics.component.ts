import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core'
import { OpenedSong } from '../song-file'
import { messages } from './messages'

// One syllable as shown in a display line. `separator` is the exact text before
// it in the lyrics, or empty at the start of a display line. `start` is where it
// starts in its display line, in CSS pixels.
interface ShownSyllable {
  index: number
  text: string
  separator: string
  start: number
}

// One display line. `countdown` is the index of its countdown among the song's
// countdowns, or -1 when it shows none. Only the first display line of a lyric
// line shows its countdown.
interface ShownLine {
  syllables: ShownSyllable[]
  countdown: number
}

// The lyrics in the Player: every display line, with each syllable highlighted
// as it is sung. The core lays out the display lines from the widths measured
// here, and works out how far the highlight has got and how many countdown dots
// have changed. The text is exactly the lyrics (D5): the dots add none.
@Component({
  selector: 'lyre-lyrics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The separators sit in their own spans, so the template's whitespace
  // handling never touches the lyric text. The countdown sits right before the
  // first syllable, with no text between them.
  template: `
    <section #section [attr.aria-label]="messages.lyrics">
      <span #measure class="measure" aria-hidden="true"></span>
      @for (line of lines(); track $index) {
        <p>
          @if (line.countdown >= 0) {
            <span class="countdown"
              ><span
                #countdown
                class="dots"
                role="progressbar"
                [attr.aria-label]="messages.countdown"
                aria-valuemin="0"
                aria-valuemax="4"
                aria-valuenow="0"
                [attr.data-countdown]="line.countdown"
                ><span class="dot"></span><span class="dot"></span><span class="dot"></span
                ><span class="dot"></span></span
            ></span>
          }
          @for (syllable of line.syllables; track syllable.index) {
            @if (syllable.separator) {
              <span>{{ syllable.separator }}</span>
            }
            <span #syllable class="syllable" [attr.data-text]="syllable.text" [style.--start]="syllable.start + 'px'">{{
              syllable.text
            }}</span>
          }
        </p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    section {
      position: relative;
      font: var(--mat-sys-headline-small);
      text-align: center;
    }
    .measure {
      position: absolute;
      top: 0;
      left: 0;
      visibility: hidden;
      white-space: pre;
    }
    p {
      margin: 0;
      white-space: nowrap;
    }
    /* The lyric text style: docs/ui-conventions.md#text-style. */
    .syllable,
    .dot {
      position: relative;
      color: #fff;
      -webkit-text-stroke: 0.125em #000;
      paint-order: stroke fill;
      text-shadow: 0.08em 0.08em 0 #000;
    }
    .syllable.sung,
    .syllable[aria-current='true']::after,
    .dot.changed {
      color: var(--lyre-highlight);
      -webkit-text-stroke-color: #fff;
    }
    /* The sung part of the syllable being sung, drawn over it up to the sweep.
       The layer is a block box, so without the normal line height it takes the
       section's taller one and its text sits lower than the syllable's. */
    .syllable[aria-current='true']::after {
      content: attr(data-text) / '';
      position: absolute;
      inset: 0;
      line-height: normal;
      clip-path: inset(0 calc(100% - (var(--sweep) - var(--start))) 0 0);
    }
    /* The countdown dots take no width, so they sit just left of the line. */
    .countdown {
      display: inline-block;
      width: 0;
    }
    .dots {
      display: inline-block;
      white-space: nowrap;
      transform: translateX(calc(-100% - 0.25em));
    }
    .dot + .dot {
      margin-left: 0.1em;
    }
    .dot::before {
      content: '●' / '';
    }
  `,
})
export class Lyrics {
  readonly song = input.required<OpenedSong>()
  readonly video = input.required<HTMLVideoElement>()
  protected readonly messages = messages
  protected readonly lines = signal<ShownLine[]>([])
  private readonly section = viewChild.required<ElementRef<HTMLElement>>('section')
  private readonly measure = viewChild.required<ElementRef<HTMLElement>>('measure')
  private readonly syllables = viewChildren<ElementRef<HTMLElement>>('syllable')
  private readonly countdowns = viewChildren<ElementRef<HTMLElement>>('countdown')
  // The width of the lyrics area, once it is drawn.
  private readonly width = signal<number | undefined>(undefined)
  // Counts the layouts asked for, so only the latest one is shown.
  private layouts = 0
  // Each syllable's start in its display line and its width, in lyric order.
  private starts: number[] = []
  private widths: number[] = []

  // What the last frame drew, so the next frame changes only what moved.
  private drawn: readonly ElementRef<HTMLElement>[] = []
  private drawnCountdowns: readonly ElementRef<HTMLElement>[] = []
  private spans: HTMLElement[] = []
  private position = 0
  private sung = 0
  private current = -1
  private total = 0

  constructor() {
    effect(() => {
      const song = this.song()
      const width = this.width()
      if (width !== undefined) void this.layOut(song, width)
    })
    let frame = 0
    let observer: ResizeObserver | undefined
    afterNextRender(() => {
      const section = this.section().nativeElement
      this.width.set(section.clientWidth)
      // Lays the lines out again when the area's width changes.
      observer = new ResizeObserver(() => this.width.set(section.clientWidth))
      observer.observe(section)
      const draw = () => {
        frame = requestAnimationFrame(draw)
        this.draw()
      }
      frame = requestAnimationFrame(draw)
    })
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    })
  }

  // Measures every syllable and a space, and has the core lay out the lines
  // that fit `maxWidth`.
  private async layOut(song: OpenedSong, maxWidth: number): Promise<void> {
    const attempt = ++this.layouts
    const section = this.section().nativeElement
    const texts = song.lyrics.map((syllable) => syllable.text)
    // Measures with the lyric font, not a fallback still on screen while it loads.
    try {
      if ('fonts' in document) await document.fonts.load(getComputedStyle(section).font, texts.join(' '))
    } catch {
      // Measures with the font the page has.
    }
    if (attempt !== this.layouts) return
    const measure = this.measure().nativeElement
    const width = (text: string) => {
      measure.textContent = text
      return measure.getBoundingClientRect().width
    }
    const widths = texts.map(width)
    const space = width(' ')
    measure.textContent = ''
    const starts: number[] = []
    let lyricLine = -1
    const lines = song.layOut(widths, space, maxWidth).map((span) => {
      let start = 0
      const syllables = song.lyrics.slice(span.start, span.end).map((syllable, k) => {
        const index = span.start + k
        if (k > 0) start += space
        starts[index] = start
        start += widths[index]
        return { index, text: syllable.text, separator: k > 0 ? syllable.separator : '', start: starts[index] }
      })
      const first = span.lyricLine !== lyricLine
      lyricLine = span.lyricLine
      return { syllables, countdown: first ? song.countdownLines.indexOf(span.lyricLine) : -1 }
    })
    this.starts = starts
    this.widths = widths
    this.lines.set(lines)
  }

  // Moves the highlight and the countdown dots to the video's time. It runs
  // every frame, so it writes no signal and changes only what moved.
  private draw(): void {
    const ms = this.video().currentTime * 1000
    const position = this.song().sweepPosition(ms)
    const total = this.song().dotsChanged(ms)
    const syllables = this.syllables()
    const countdowns = this.countdowns()
    const full = syllables !== this.drawn || countdowns !== this.drawnCountdowns
    if (!full && position === this.position && total === this.total) return
    if (full) {
      this.drawn = syllables
      this.drawnCountdowns = countdowns
      this.spans = syllables.map((syllable) => syllable.nativeElement)
    }
    if (full || total !== this.total) {
      // Countdown k shows clamp(total - 4k, 0, 4) dots changed.
      for (const { nativeElement: dots } of countdowns) {
        const changed = Math.min(Math.max(total - 4 * Number(dots.dataset['countdown']), 0), 4)
        dots.setAttribute('aria-valuenow', String(changed))
        Array.from(dots.children).forEach((dot, i) => dot.classList.toggle('changed', i < changed))
      }
      this.total = total
    }
    const spans = this.spans
    const sung = Math.min(Math.floor(position), spans.length)
    const current = position % 1 > 0 ? sung : -1
    const [from, to] = full ? [0, spans.length] : [Math.min(this.sung, sung), Math.max(this.sung, sung)]
    for (let i = from; i < to; i++) spans[i].classList.toggle('sung', i < sung)
    if (full || current !== this.current) {
      for (const span of full ? spans : [spans[this.current]]) span?.removeAttribute('aria-current')
      spans[current]?.setAttribute('aria-current', 'true')
    }
    if (current >= 0) {
      const sweep = this.starts[current] + (position - sung) * this.widths[current]
      spans[current]?.parentElement?.style.setProperty('--sweep', `${sweep}px`)
    }
    this.position = position
    this.sung = sung
    this.current = current
  }
}
