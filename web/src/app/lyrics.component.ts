import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core'
import { LyricsRows, OpenedSong } from '../song-file'
import { messages } from './messages'

// The lyric font size for a video `height` CSS pixels tall:
// docs/ui-conventions.md#lyrics-area.
export function lyricFontSize(height: number): number {
  return Math.max(height / 10, 16)
}

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

// The lyrics in the Player: the two display lines the core picks for the video's
// time, with each syllable highlighted as it is sung. The core lays out the
// display lines from the widths measured here, and works out which ones show,
// how far the highlight has got and how many countdown dots have changed. The text is exactly the lyrics (D5): the dots add none.
@Component({
  selector: 'lyre-lyrics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The separators sit in their own spans, so the template's whitespace
  // handling never touches the lyric text. The countdown sits right before the
  // first syllable, with no text between them.
  template: `
    <section
      #section
      [attr.aria-label]="messages.lyrics"
      [style.--margin]="margin() + 'px'"
      [style.--sung]="sungColour()"
    >
      <span #measure class="measure" aria-hidden="true"></span>
      <span #dotsMeasure class="measure dots" aria-hidden="true"
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span
      ></span>
      @for (line of shown(); track $index) {
        <p [class.bottom]="$index === 1">
          @if (line) {
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
              <span
                #syllable
                class="syllable"
                [attr.data-index]="syllable.index"
                [attr.data-text]="syllable.text"
                [style.--start]="syllable.start + 'px'"
                >{{ syllable.text }}</span
              >
            }
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
      /* After the shorthand, which resets the weight. The measuring spans and the
         countdown dots inherit it: docs/ui-conventions.md#lyrics-area. */
      font-weight: 700;
      /* The font size is set from the video's height, so the line height and the
         gap follow it. One gap of 0.3em is used at the sides, below the rows and
         between them: docs/ui-conventions.md#lyrics-area. */
      line-height: 1.25;
      padding: 0 0.3em 0.3em;
    }
    .measure {
      position: absolute;
      top: 0;
      left: 0;
      visibility: hidden;
      white-space: pre;
    }
    /* A row box is always one line height tall, so the gaps are between row boxes
       and a row keeps its place when it is empty. The top row's line starts after
       the margin for the countdown dots, and the bottom row's line ends at the
       right gap. */
    p {
      margin: 0;
      height: 1lh;
      white-space: nowrap;
      text-align: left;
      padding-left: var(--margin, 0);
    }
    p.bottom {
      text-align: right;
      margin-top: 0.3em;
      padding-left: 0;
    }
    /* The lyric text style: docs/ui-conventions.md#text-style. */
    .syllable,
    .dot {
      position: relative;
      color: #fff;
      -webkit-text-stroke: 0.125em #000;
      paint-order: stroke fill;
      /* Not text-shadow: Chromium paints the fill's shadow over the stroke. */
      filter: drop-shadow(0.15em 0.15em 0 #000);
    }
    /* Sung text takes the song's vocal role colour, set in --sung. */
    .syllable.sung,
    .syllable[aria-current='true']::after,
    .dot.changed {
      color: var(--sung);
      -webkit-text-stroke-color: #fff;
    }
    /* The sung part of the syllable being sung, drawn over it up to the sweep.
       The layer is a block box, so without the normal line height it takes the
       section's taller one and its text sits lower than the syllable's. The
       layer is clipped only at the sweep. At the other sides the clip reaches
       1 em past the box, so the outline, overhanging glyphs and marks above the
       box are covered too. */
    .syllable[aria-current='true']::after {
      content: attr(data-text) / '';
      position: absolute;
      inset: 0;
      line-height: normal;
      clip-path: inset(-1em calc(100% - (var(--sweep) - var(--start))) -1em -1em);
    }
    /* The countdown dots take no width, so they sit just left of the line. Their
       box includes the gap to the line, so it is as wide as the margin. */
    .countdown {
      display: inline-block;
      width: 0;
    }
    .dots {
      display: inline-block;
      white-space: nowrap;
      padding-right: 0.25em;
      transform: translateX(-100%);
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
  // Every laid-out display line, in the order the core returned them.
  private readonly lines = signal<ShownLine[]>([])
  // The display lines the core picks for the video's time, as positions in
  // `lines`.
  private readonly rows = signal<LyricsRows>({ top: undefined, bottom: undefined })
  // The two rows: the top and the bottom line, or undefined for an empty row.
  protected readonly shown = computed(() => {
    const { top, bottom } = this.rows()
    const lines = this.lines()
    return [top, bottom].map((index) => (index === undefined ? undefined : lines[index]))
  })
  // The width of the countdown dots with their gap, in CSS pixels. The top row's
  // line starts after it.
  protected readonly margin = signal(0)
  // The colour of sung text: the token of the song's vocal role.
  protected readonly sungColour = computed(() => `var(--lyre-vocal-${this.song().details.vocalRole})`)
  private readonly section = viewChild.required<ElementRef<HTMLElement>>('section')
  private readonly measure = viewChild.required<ElementRef<HTMLElement>>('measure')
  private readonly dotsMeasure = viewChild.required<ElementRef<HTMLElement>>('dotsMeasure')
  private readonly syllables = viewChildren<ElementRef<HTMLElement>>('syllable')
  private readonly countdowns = viewChildren<ElementRef<HTMLElement>>('countdown')
  // The width of the lyrics area less both side gaps, and the lyric font size, in
  // CSS pixels, once they are measured.
  private readonly size = signal<{ width: number; fontSize: number } | undefined>(undefined)
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
      const size = this.size()
      if (size) void this.layOut(song, size.width)
    })
    let frame = 0
    let observer: ResizeObserver | undefined
    afterNextRender(() => {
      this.measureSize()
      // Lays the lines out again when the area's width or the video's size changes.
      observer = new ResizeObserver(() => this.measureSize())
      observer.observe(this.section().nativeElement)
      observer.observe(this.video())
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

  // Sets the lyric font size from the video's displayed height, and measures the
  // area's width less both side gaps with it. It writes the signal only when
  // either changed.
  private measureSize(): void {
    const section = this.section().nativeElement
    const fontSize = lyricFontSize(this.video().clientHeight)
    // Set on the element itself, so the measuring that follows sees the new size.
    section.style.fontSize = `${fontSize}px`
    const style = getComputedStyle(section)
    const width = section.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
    const current = this.size()
    if (current?.width !== width || current.fontSize !== fontSize) this.size.set({ width, fontSize })
  }

  // Measures every syllable, a space and the countdown dots, and has the core lay
  // out the lines that fit `maxWidth`, the area's width less both side gaps, less
  // the dots' width.
  private async layOut(song: OpenedSong, maxWidth: number): Promise<void> {
    const attempt = ++this.layouts
    const section = this.section().nativeElement
    const texts = song.lyrics.map((syllable) => syllable.text)
    // Measures with the lyric font, not a fallback still on screen while it loads.
    try {
      if ('fonts' in document) await document.fonts.load(getComputedStyle(section).font, `${texts.join(' ')}●`)
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
    const margin = this.dotsMeasure().nativeElement.getBoundingClientRect().width
    const starts: number[] = []
    let lyricLine = -1
    const lines = song.layOut(widths, space, Math.max(maxWidth - margin, 0)).map((span) => {
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
    this.margin.set(margin)
    this.lines.set(lines)
    this.showRows()
  }

  // Shows the display lines the core picks for the video's time. It writes the
  // signal only when the rows changed.
  private showRows(): void {
    const next = this.song().lyricsRows(this.video().currentTime * 1000)
    const current = this.rows()
    if (next.top !== current.top || next.bottom !== current.bottom) this.rows.set(next)
  }

  // Moves the highlight and the countdown dots to the video's time. It runs
  // every frame, so it writes no signal and changes only what moved.
  private draw(): void {
    this.showRows()
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
      // Only the shown syllables exist, so the list has holes.
      this.spans = []
      for (const { nativeElement: span } of syllables) this.spans[Number(span.dataset['index'])] = span
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
    const count = this.song().lyrics.length
    const sung = Math.min(Math.floor(position), count)
    const current = position % 1 > 0 ? sung : -1
    const [from, to] = full ? [0, count] : [Math.min(this.sung, sung), Math.max(this.sung, sung)]
    for (let i = from; i < to; i++) spans[i]?.classList.toggle('sung', i < sung)
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
