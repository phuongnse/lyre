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
  `--lyre-vocal-*` from [Lyrics in the Player](#lyrics-in-the-player).
- Put no hard-coded colours, font sizes, radii or spacing values in
  components. The exceptions are the white and black of the
  [lyric text style](#text-style), its em-based outline and shadow sizes, the
  [vocal role colours](#vocal-role-colours), and the lyric font size with its
  16 px floor and its bold weight (see [Lyrics area](#lyrics-area)).
- All tokens come from one seed colour, `#6B5778` (smoky purple). Two sets of
  colours do not come from the seed, and a seed change never changes them: the
  white and black of the
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
  the play position carry on. Each track plays by the type its song file
  stores. Opening a song reads every init chunk to check its type. The
  original track's media segments are read only once the singer switches to
  it. A file the core refuses shows one plain message, "not a song file" or
  "damaged or incomplete", and nothing plays.
- A song whose stored media type the device cannot play shows one plain
  message naming the track: "This device cannot play this song's video.", or
  its karaoke track or its original track. Nothing plays, and the song is not
  kept in the library
  ([D24](decisions.md#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed)).
  *(planned for M2)* The message names the codec and the kind of media
  instead, such as "This device cannot play H.265 video".
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

- The web client keeps each song file that opens without error, and that
  this device can play, in the browser's IndexedDB, one per song ID. Opening a song again replaces its
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
  is drawn over the outline. It is crisp: offset 0.1 em to the right and
  0.1 em down, with a blur of 0. On the web it is
  `filter: drop-shadow(0.1em 0.1em 0 #000)` on each syllable and dot, not
  `text-shadow`, which Chromium paints over the stroke. In Compose the shadow
  is drawn first, then the stroke, then the fill *(planned for M4)*.
- Outline width and shadow offset are given in em, so they scale with the font
  size.
- As the sweep passes a syllable, its fill turns to the song's
  [vocal role colour](#vocal-role-colours) and its outline turns white,
  together.
  The shadow never changes.
- The sung part of the syllable being sung is cut only at the sweep edge.
  Behind it, the whole glyph is sung, including outline, overhangs and marks
  that reach past the syllable's box.
- Lyrics have no backdrop. The outline and shadow keep them readable over any
  video.

### Vocal role colours

- Sung lyrics and swept [countdown dots](#countdown-dots) take the colour of
  the song's [vocal role](domain/concepts.md#songs), from M1.
- Sung text uses only these three colours, as Vietnamese karaoke does.
- The colours do not come from the seed. They are the same on the web and on
  Android. On the web the tokens are defined in `web/src/styles.scss`.
- Colouring each lyric line by its own role is *(planned for M8)*.

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
- The two rows, with their countdown dots, stay inside the video's box. Each
  row is a box one line height tall, 1.25 times the font size, and keeps its
  place when the other row is empty. The boxes are 0.3 times the font size
  apart.
- The visible gap between the rows runs from the top row's descender line to
  the bottom row's cap-height line. Three margins equal it: the left margin,
  from the video's left edge to the countdown dots, the right margin, from the
  end of the bottom row's line to the video's right edge, and the space from
  the bottom row's descender line to the video's bottom. They come from the
  lyric font's metrics (ascent, descent and cap height), never from the glyphs
  shown, so the rows never move with the text. The gap is a starting point to
  adjust after trying it.
- The two rows take at most 35% of the video's height. At the font size of
  1/10 of the height they take about 34%. Nothing clamps them: only the 16 px
  floor on the font size can push them past 35%, on videos under about 160 px
  tall.
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
- The countdown dots sit at the left margin, just left of the top row's line.
  The area keeps a margin as wide as the dots, so they stay inside it.
- The core lays out the display lines to fit the area's width less both side
  margins and the width of the dots margin. A full-width line then never runs
  into the dots or the right margin.
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
- The dots are swept one by one from the left, and each dot is swept from left
  to right during its step, like sung text. Behind the sweep its fill is the
  line's vocal role colour and its outline white. Ahead of it the dot is white
  with a black outline. Only the sweep edge cuts the swept part, so no black
  outline shows to its left, above it or below it. The shadow does not change.
- Each step takes 0.5 s. The fourth step ends as the line's first syllable
  starts, so the sweep runs on into the line's first syllable.
- When the gap is shorter than 2 s, the four steps share it evenly.
- The core works out which lyric lines have dots and how far the sweep has
  got, so both clients agree.
- The dots sit just left of the top row's line, which is always the first
  display line of their lyric line. They sit in the Lyrics area's left
  margin, just inside the left margin, take no width from the line and add no text, so the line stays
  exact ([D5](decisions.md#d5-supplied-lyrics-are-authoritative--agreed)).
- Swept dots stay swept after their line starts. A seek back undoes the sweep
  after the new time.
- On the web each set of dots is a progress indicator named "Countdown", from
  the strings catalogue, with a value from 0 to 4 for the dots fully swept. The
  same `requestAnimationFrame` loop as the highlight updates them, with no
  signal update per frame.

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)), the task
  check page at `#/task-check`, the source check page at
  `#/source-check`, the model check page at `#/model-check` and the
  separation check page at `#/separation-check`.
- The task check page runs a task of test stages, with its progress and a
  Cancel button. The Playwright journeys use it to check cancel and the
  cleanup after a reload ([processing](architecture.md#processing-planned-for-m2)).
- The source check page reads a picked source's details: its duration, its
  streams, its start offset, and its title, artist and composer, shown
  exactly as stored. A source without audio, or a file it cannot read, gets
  one plain message. A source this browser cannot play shows a reason that
  names the track and the codec, such as "This browser cannot play this
  source's video (H.265), so a song cannot be made from it.", next to its
  details. When neither track plays, the video is named. The page can also
  decode the audio at a stage's rate, and shows what came out: its rate,
  channels, length, tone and where sound starts.
  Audio the browser cannot decode gets the no-audio message. When the core
  gives the audio a stored type, a **Package the original track** button
  packages it in a Web Worker, and shows the original track's stored type,
  its segment count and its total duration. A failure shows one message:
  "This source's audio could not be packaged for a song." Until separation
  exists, a **Choose a karaoke track** button picks a second audio file that
  stands in for the karaoke track. Once one is picked, a **Make the
  tracks** button packages the original track, makes the karaoke track from
  it, and then packages the source's video, in a Web Worker. The page then
  lists each track's segments, with their start and end times, and shows the
  song's duration, which is the karaoke track's total. An audio-only source
  has no video segment list. When the browser cannot encode Opus, it shows
  only "This browser cannot encode audio, so a song cannot be made in it.",
  and makes nothing. A source whose keyframes are more than 20 s apart shows
  "This source's keyframes are more than 20 s apart, so a song cannot be made
  from it." A source with one group of video frames over 64 MiB shows "This
  source has a group of video frames over 64 MiB, so a song cannot be made
  from it." Any other failure, such as an unreadable karaoke file, shows one
  message: "The tracks could not be made for a song." **Choose the lyrics**
  and **Choose a timing file** buttons pick a lyrics file and a hand-written
  [timing file](reference/lyre-cli.md#timing-file). A **Vocal role** choice
  of Female or Male has no default. Once the karaoke track, the lyrics, the
  timing file and the role are all picked, a **Make the song file** button
  reads the timing file against the lyrics, makes every track and the
  thumbnail, and writes a version-0 song file through the core, in a Web
  Worker. The song's title, artist and composer are the source's tags,
  exactly as stored. Without a title tag, the title is the source's file name
  without its extension. The lyrics are stored exactly as supplied (D5). The
  page then shows a **Download the song file** link, named after the source
  file with `.lyre` in place of its extension, which the Player opens. Each
  refusal a user can fix has its own message, and none offers a download:
  "The lyrics file is not valid lyrics.", "The timing file does not match the
  lyrics." and "The timing ends after the song, so the song file was not
  made." The video refusals and the cannot-encode message are the same as for
  making the tracks. Any other failure shows "The song file could not be
  made." The page never shows the core's own text. The Playwright journeys
  use it to check reading a source, decoding its audio, packaging it, making
  the tracks and making a song file that the Player plays.
- The model check page downloads, checks and keeps the 56-byte test model
  file `test-two-block`. A progress bar and a line below it show the bytes
  downloaded, and the line stays after the download ends. The status line
  says that the file passed and is kept, that it failed its check and was
  deleted, or that it could not be downloaded. Each names the file. When the
  browser refuses persistent storage, a note says it may remove the
  downloaded models. The Playwright journeys use it to check a download, a
  later load that downloads nothing, and a file that fails its check.
  A **Run the test separator** button checks both test separator files, runs
  one window of silence in a Web Worker, and says which backend ran and the
  shapes of the two outputs. Adding `?backend=wasm` to the URL, as in
  `#/model-check?backend=wasm`, makes it run on WebAssembly even when the
  browser has a GPU. The Playwright journeys use it to check the run without
  a GPU, under the page's policy and from the site's own origin.
  An **Align test audio** control has a choice of test aligner, Omnilingual
  or lyric-alignment, and a **Force WebAssembly** checkbox, which starts
  ticked with `?backend=wasm`. The button opens a lyrics file picker, and
  picking a file times its syllables on 40 s of test audio in a Web Worker
  ([processing](architecture.md#processing-planned-for-m2)). While it runs, a
  line shows the backend and the windows done out of the total, such as
  "Aligning on WebAssembly: 1 of 2 windows done". When it ends, the line says
  "Aligned on WebAssembly: 2 of 2 windows done", and another gives the number
  of syllables timed and says that the song file timing check accepted the
  timing. A timing the check refuses gets its own message, and any other
  failure one plain message. Neither shows lyric text or error text. The
  Playwright journeys use it to check a run of each test aligner on
  WebAssembly, under the page's policy.
- The separation check page separates a picked source's audio into vocals and
  a karaoke track in a Web Worker
  ([processing](architecture.md#processing-planned-for-m2)). While it runs, a
  progress bar and the status line show the backend and the windows done out
  of the total. When it ends, the page shows the backend that ran and the
  lengths of the source, the vocals and the karaoke track. A run that fails
  the sum check names the rule and the value it measured. A source without
  audio, or a file it cannot read, gets the source check page's messages, and
  a separator that cannot be loaded gets its own. The page runs htdemucs.
  `?model=test` runs the test separator instead, and `?backend=wasm` makes it
  run on WebAssembly, as on the model check page. The Playwright journeys use
  it to check a whole run of the test separator and that the page stays
  responsive.
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
