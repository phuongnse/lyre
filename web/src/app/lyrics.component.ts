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

// The lyrics in the Player: every display line, with each syllable highlighted
// as it is sung. The core lays out the display lines from the widths measured
// here, and works out how far the highlight has got. The text is exactly the
// lyrics (D5).
@Component({
  selector: 'lyre-lyrics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The separators sit in their own spans, so the template's whitespace
  // handling never touches the lyric text.
  template: `
    <section #section [attr.aria-label]="messages.lyrics">
      <span #measure class="measure" aria-hidden="true"></span>
      @for (line of lines(); track $index) {
        <p>
          @for (syllable of line; track syllable.index) {
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
    .syllable {
      position: relative;
      color: #fff;
      -webkit-text-stroke: 0.125em #000;
      paint-order: stroke fill;
      text-shadow: 0.08em 0.08em 0 #000;
    }
    .syllable.sung,
    .syllable[aria-current='true']::after {
      color: var(--lyre-highlight);
      -webkit-text-stroke-color: #fff;
    }
    /* The sung part of the syllable being sung, drawn over it up to the sweep. */
    .syllable[aria-current='true']::after {
      content: attr(data-text) / '';
      position: absolute;
      inset: 0;
      clip-path: inset(0 calc(100% - (var(--sweep) - var(--start))) 0 0);
    }
  `,
})
export class Lyrics {
  readonly song = input.required<OpenedSong>()
  readonly video = input.required<HTMLVideoElement>()
  protected readonly messages = messages
  protected readonly lines = signal<ShownSyllable[][]>([])
  private readonly section = viewChild.required<ElementRef<HTMLElement>>('section')
  private readonly measure = viewChild.required<ElementRef<HTMLElement>>('measure')
  private readonly syllables = viewChildren<ElementRef<HTMLElement>>('syllable')
  // The width of the lyrics area, once it is drawn.
  private readonly width = signal<number | undefined>(undefined)
  // Counts the layouts asked for, so only the latest one is shown.
  private layouts = 0
  // Each syllable's start in its display line and its width, in lyric order.
  private starts: number[] = []
  private widths: number[] = []

  // What the last frame drew, so the next frame changes only what moved.
  private drawn: readonly ElementRef<HTMLElement>[] = []
  private spans: HTMLElement[] = []
  private position = 0
  private sung = 0
  private current = -1

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
    const lines = song.layOut(widths, space, maxWidth).map((span) => {
      let start = 0
      return song.lyrics.slice(span.start, span.end).map((syllable, k) => {
        const index = span.start + k
        if (k > 0) start += space
        starts[index] = start
        start += widths[index]
        return { index, text: syllable.text, separator: k > 0 ? syllable.separator : '', start: starts[index] }
      })
    })
    this.starts = starts
    this.widths = widths
    this.lines.set(lines)
  }

  // Moves the highlight to the video's time. It runs every frame, so it writes
  // no signal and changes only the syllables whose state moved.
  private draw(): void {
    const position = this.song().sweepPosition(this.video().currentTime * 1000)
    const syllables = this.syllables()
    const full = syllables !== this.drawn
    if (!full && position === this.position) return
    if (full) {
      this.drawn = syllables
      this.spans = syllables.map((syllable) => syllable.nativeElement)
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
