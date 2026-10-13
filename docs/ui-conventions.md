# UI conventions

Both clients share one design language. The screens are not identical, but
colour, type, shape and behaviour feel the same. This follows
[D19](decisions.md#d19-web-client-on-angular-both-clients-on-material-3--agreed).

The web client follows these rules now. The Android app follows them from
M4.

## Angular

- Use standalone components only. Do not use NgModules.
- Keep state in signals: `signal`, `computed`, `input()`, `output()` and
  `model()`.
- Get dependencies with `inject()`.
- Write control flow with `@if`, `@for` (always with `track`) and `@switch`.
  Never use `*ngIf` or `*ngFor`.
- Change detection is zoneless (`provideZonelessChangeDetection()`). Every
  component also sets `ChangeDetectionStrategy.OnPush`.
- Use no decorator inputs and no other older patterns.
- Routes use hash URLs, such as `/lyre/#/route`. GitHub Pages cannot send a
  deep link to `index.html`. The build uses relative asset paths, so the same
  build works at the site root and under `/lyre/`.

## Theming

- Use only Material 3 system tokens. On the web these are the `--mat-sys-*`
  CSS variables. In Compose they are `MaterialTheme.colorScheme`,
  `typography` and `shapes`. The only other colour tokens are the Lyre tokens
  `--lyre-highlight` and `--lyre-vocal-*` from
  [Lyrics in the Player](#lyrics-in-the-player).
- Put no hard-coded colours, font sizes, radii or spacing values in
  components. The exceptions are the white and black of the
  [lyric text style](#text-style), its em-based outline and shadow sizes, the
  [vocal role colours](#vocal-role-colours), and the lyric font size with its
  16 px floor and its bold weight (see [Lyrics area](#lyrics-area)).
- All tokens come from one seed colour, `#6B5778` (smoky purple), including the
  [highlight colour](#highlight-colour). Two sets of colours do not come from
  the seed, and a seed change never changes them: the white and black of the
  [lyric text style](#text-style) and the
  [vocal role colours](#vocal-role-colours).
- The same seed generates the Kotlin `ColorScheme`, `Typography` and `Shapes`
  *(planned for M4)*. `dynamicColor` is off.
- The typeface must cover Vietnamese, including stacked diacritics.

## Strings

- The UI is in Vietnamese.
- Every user-visible string, including aria labels, lives in one catalogue
  from the start. A second language is then cheap to add.
- The catalogue is typed and read at runtime. It is one TypeScript module that
  maps message IDs to Vietnamese text. This is agreed in D19.
- *Why:* one build serves GitHub Pages, and the language can change without a
  reload. Angular's built-in i18n needs one build per language.
- The catalogue is `web/src/app/messages.ts`. Its text is still English.
  The Vietnamese text comes in a later issue.
- Lyrics are never strings in the catalogue. They are shown exactly as
  supplied
  ([D5](decisions.md#d5-supplied-lyrics-are-authoritative--agreed)).

## Layout and access

- Design phone first, landscape included. The Player in landscape matters.
- Every control is reachable by keyboard, has a visible focus and has an
  accessible name.
- Playwright finds elements by role and label, with `getByRole` and
  `getByLabel`. It never uses a CSS class or the DOM structure.

## Player

- The Player is custom on both clients. It is not a Material component. It
  uses the same tokens.
- The web Player opens a song file chunk by chunk through the core, never
  reading the whole file at once. It plays the video and the karaoke track
  through Media Source Extensions, with a Play/Pause button. A Karaoke /
  Original switch shows the chosen track, and starts on Karaoke for each song.
  Switching replaces only the audio in the running stream, so the video and
  the play position carry on. The original track is read only once the singer
  switches to it. A file the core refuses shows one plain message, "not a song
  file" or "damaged or incomplete", and nothing plays.
- The web Player shows the lyrics in a Lyrics area over the bottom of the
  video, in two rows. See [Lyrics area](#lyrics-area). The core lays out the
  display lines from the widths the client measures, when the song opens and
  when the area's width or the video's size changes. The syllable being sung carries `aria-current`.
  Between lines, none does.
- On the web, a `requestAnimationFrame` loop reads the media time. It sets a
  CSS variable, the sweep progress, on the active display line. It also asks
  the core for the rows and updates them only when they change. It never
  causes a re-render or a signal update per frame.
- In Compose *(planned for M4)* the idea is the same. Read the frame time in
  the draw phase, so nothing recomposes per frame.
- The highlight goes syllable by syllable. See
  [why](domain/knowledge.md#lyrics).

## Library

- The web client keeps each song file that opens without error in the
  browser's IndexedDB, one per song ID. Opening a song again replaces its
  kept copy, so each song is listed once.
- The library lists the kept songs under the Player, the most recently
  opened first. Each shows its title, and its artist and composer when they
  are known, exactly as the song file stores them. Choosing one plays it.
- It asks the browser for persistent storage when a song is kept, not when the
  page loads. When the browser refuses, the library says that the browser may
  clear these songs. See [why](domain/knowledge.md#running-on-the-users-device).
- Playback never depends on the library. If a song cannot be kept, it still
  plays, and no error is shown.

## Lyrics in the Player

How the Player draws [lyrics](domain/concepts.md#songs). These rules apply
from M1, except those marked *(planned for M8)*.

### Text style

- A syllable not yet sung has a white `#FFFFFF` fill, a black `#000000`
  outline and a black shadow.
- The outline is a 0.125 em stroke centred on the glyph edge and drawn under
  the fill, so about 0.06 em shows outside the glyph. On the web this is
  `-webkit-text-stroke: 0.125em` with `paint-order: stroke fill`. In Compose
  the stroke layer is drawn first, then the fill *(planned for M4)*.
- The shadow is one layer under the whole glyph, outline included, so nothing
  is drawn over the outline. It is crisp: offset 0.15 em to the right and
  0.15 em down, with a blur of 0. On the web it is
  `filter: drop-shadow(0.15em 0.15em 0 #000)` on each syllable and dot, not
  `text-shadow`, which Chromium paints over the stroke. In Compose the shadow
  is drawn first, then the stroke, then the fill *(planned for M4)*.
- Outline width and shadow offset are given in em, so they scale with the font
  size.
- As the sweep passes a syllable, its fill turns to the
  [highlight colour](#highlight-colour) and its outline turns white, together.
  The shadow never changes.
- Lyrics have no backdrop. The outline and shadow keep them readable over any
  video.

### Highlight colour

- A song with no vocal role, or with one vocal role, uses the highlight
  colour. It is made from the seed: the seed's HCT hue, at the highest chroma
  that hue allows, at HCT tone 45.
- The formula is `Hct.from(Hct.fromInt(seed).hue, 200, 45)` from Material
  Color Utilities. Asking for chroma 200 returns the highest chroma the hue
  allows at that tone. For the seed `#6B5778` the result is `#A100FB`.
- It is not the scheme's `primary` token, which is too pale under a white
  outline.
- It is the token `--lyre-highlight` on the web. Compose uses the same value
  *(planned for M4)*.
- It follows the seed. A seed change recomputes it.
- A song with more than one vocal role colours each lyric line by its role.
  See [vocal role colours](#vocal-role-colours) *(planned for M8)*.

### Vocal role colours

- Lyrics of a song with more than one [vocal role](domain/concepts.md#songs)
  are coloured by role *(planned for M8)*.
- The colours do not come from the seed. They are the same on the web and on
  Android.

| Vocal role | Token | Colour |
| --- | --- | --- |
| Male | `--lyre-vocal-male` | `#0000FF` (blue) |
| Female | `--lyre-vocal-female` | `#FF0000` (red) |
| Duet | `--lyre-vocal-duet` | `#FF00FF` (magenta) |

Compose uses the same three values *(planned for M4)*.

### Lyrics area

- The Lyrics area lies over the bottom of the video, inside the video's box,
  with no backdrop. Nothing else on the page moves into that space.
- The lyric font size is 1/10 of the video's displayed height, and never under
  16 px. When the video's size changes, the display lines are laid out again
  for the new size. The rule is a starting point to adjust after trying it on a
  phone.
- Lyric text and the countdown dots are bold, weight 700. The core lays out the
  display lines with the bold font's widths.
- The two rows, with their countdown dots, stay inside the video's box. One
  gap of 0.3 times the lyric font size is used in four places: at the left
  and right sides, below the bottom row and between the two rows. It is
  measured between row boxes, not glyph ink. Each row is one line height tall,
  1.25 times the font size, and keeps its place when the other row is empty.
  The gap is a starting point to adjust after trying it.
- The Lyrics area has two rows. The top row's line is aligned left and the
  bottom row's line is aligned right. A row shows one display line or nothing.
- A group of display lines starts at the first display line of each lyric
  line that has [countdown dots](#countdown-dots). It runs to the next such
  line.
- In a group, display lines take turns between the rows, starting in the top
  row.
- The first group shows from media time 0. A later group shows once the last
  syllable of the group before it ends. Its first two display lines show
  together.
- When the display line in the other row starts, at its first syllable's
  start, a row shows the group's next display line not shown yet. So the line
  just sung stays during the gap between lines. If the group has none, the row
  keeps the finished line, fully sung, until the group's last line ends.
- The countdown dots sit at the left gap, just left of the top row's line.
  The area keeps a left margin as wide as the dots, so they stay inside it.
- The core lays out the display lines to fit the area's width less both side
  gaps and the width of the dots margin. A full-width line then never runs
  into the dots or the right gap.
- The rows depend only on the media time, so they follow seeks.
- The core works out which display line each row shows, so both clients
  agree.

### Countdown dots

- Four dots come before a lyric line at the start of the song and after a
  break of 5 s or longer with no singing.
- They also come when the vocal role changes from one line to the next
  *(planned for M8)*.
- The gap before a line runs from the end of the previous line's last syllable
  to the start of this line's first syllable. At the start of the song it runs
  from media time 0.
- Each dot uses the lyric [text style](#text-style) at the line's font size.
- The dots change one by one from the left, like sung text. The fill turns
  from white to the line's highlight colour and the outline from black to
  white. The shadow does not change.
- Each step takes 0.5 s. The fourth step ends as the line's first syllable
  starts.
- When the gap is shorter than 2 s, the four steps share it evenly.
- Each dot changes all at once when its step ends.
- The core works out which lyric lines have dots and how many have changed, so
  both clients agree.
- The dots sit just left of the top row's line, which is always the first
  display line of their lyric line. They sit in the Lyrics area's left
  margin, just inside the left gap, take no width from the line and add no text, so the line stays
  exact ([D5](decisions.md#d5-supplied-lyrics-are-authoritative--agreed)).
- Changed dots stay changed after their line starts. A seek back undoes only
  the steps that end after the new time.
- On the web each set of dots is a progress indicator named "Countdown", from
  the strings catalogue, with a value from 0 to 4 for the dots changed. The
  same `requestAnimationFrame` loop as the highlight updates them, with no
  signal update per frame.

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)).
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
