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
  [lyric text style](#text-style), its em-based outline and shadow sizes, and
  the [vocal role colours](#vocal-role-colours).
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
- The web Player lists every display line of the lyrics in a Lyrics area
  under the video. The core lays them out from the widths the client
  measures, when the song opens and when the area's width changes. The
  syllable being sung carries `aria-current`. Between lines, none does.
- On the web, a `requestAnimationFrame` loop reads the media time. It sets a
  CSS variable, the sweep progress, on the active display line. It never
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
- The shadow is crisp. It is offset 0.08 em to the right and 0.08 em down,
  with a blur of 0.
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

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)).
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
