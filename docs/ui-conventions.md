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
  [lyric text style](#text-style), the black and white of the
  [device code's QR code](#device-code) and the
  [recovery key's QR code](#recovery-key), its em-based outline and shadow sizes, the
  [vocal role colours](#vocal-role-colours), and the lyric font size with its
  16 px floor and its bold weight (see [Lyrics area](#lyrics-area)).
- All tokens come from one seed colour, `#6B5778` (smoky purple). Three sets of
  colours do not come from the seed, and a seed change never changes them: the
  white and black of the
  [lyric text style](#text-style), the black and white of the
  [QR codes](#device-code) and the
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
- The open button takes a song file with its access files (`.lyre` and
  `.lyrekey`), in one choice. The extension only sorts the files into two
  kinds. The core matches an access file to its song by song ID, never by file
  name ([D31](decisions.md#d31-song-files-are-encrypted-shared-and-recovered-with-one-scheme--agreed)).
  It tries each access file and uses the one that opens the song.
- A version-0 song file, opened or kept, shows one plain message, "This song
  file is from an older version of Lyre and no longer plays.", and nothing
  plays or is kept. Access files chosen with it make no difference, and the
  Player asks for no unlock. The model check page's measured song plays from
  memory, may still be version 0, and is never kept. The source check page's
  song is version 1 and opens with its access file, and is never kept. A song
  made in the [Making a song](#making-a-song) section is version 1 and opens
  like any other, with its access file.
- A version-1 song file needs this page load's device unlock. The Player asks
  for it only when it opens such a file that has an access file chosen with
  it, and the [This device section](#device-code) shares the same unlock. The
  Player never holds the device key itself. It passes the core's key handle on
  to the core.
- A version-1 song file that does not open shows one plain message, "This song
  cannot be opened on this device.", and nothing plays or is kept. This covers
  no access file chosen, an access file for another device or another song, a
  changed song file or access file, and an unlock that is cancelled or
  refused. The This device section explains an unlock problem in more detail.
- A song opened with an owner access file shows a **Share** button under the
  Player. This covers a song chosen from the library and a song just made. A
  song opened with a recipient access file shows no Share
  ([D13](decisions.md#d13-only-the-owner-shares-a-song--agreed)), and neither
  does a Player given its song through its input, as the check pages do.
- Share opens a short form with a "Device code" field and a **Make the access
  file** button. It says plainly that a share cannot be undone and that the
  device shared with keeps the song
  ([D9](decisions.md#d9-lyre-has-no-server--agreed)).
- For a valid device code, the form shows that code's fingerprint, asks the
  owner to check it against the one on the other device before sending the
  file, and offers **Download the access file**, named after the song's title
  with `.lyrekey`. Changing the code clears the result.
- An invalid or changed device code shows one message, "This is not a valid
  device code.", and no fingerprint and no download. The core checks the code
  before it reads anything else.
- A song whose stored media type the device cannot play shows one plain
  message naming the track: "This device cannot play this song's video.", or
  its karaoke track or its original track. Nothing plays, and the song is not
  kept in the library
  ([D24](decisions.md#d24-sources-are-repackaged-and-only-the-karaoke-track-is-encoded--agreed)).
  *(planned for M4)* The message names the codec and the kind of media
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
- A version-1 song is kept with the access file that opened it. Choosing it
  after a reload asks for the device unlock again, then plays it. A song made
  in the [Making a song](#making-a-song) section is kept this way.
- An entry kept without an access file, from version 0, is listed with "No
  longer plays" next to its title. Choosing it shows the old-version message.
  The entry stays until a way to remove it exists.
- It asks the browser for persistent storage when a song is kept, not when the
  page loads. When the browser refuses, the library says that the browser may
  clear these songs. See [why](domain/knowledge.md#running-on-the-users-device).
- Playback never depends on the library. If a song cannot be kept, it still
  plays, and no error is shown.

## Making a song

The main page of the web client has a Make a song section. It picks the
files, the song details and the vocal role, and runs the task. The Android app has no such section
([D27](decisions.md#d27-the-android-app-plays-and-receives-songs--agreed)).
The section runs a
[task](domain/concepts.md#processing) from a source and its lyrics to a song
file. The stage names and messages below are examples. The issues that build
the section may refine them, and update this section when they do.

- **Choose a source** and **Choose the lyrics** buttons pick the two files.
  Reading the source is stage 1. It runs on the main thread as soon as the
  source is picked. A source the page refuses gets the source check page's
  messages (see [check pages](#check-pages)). A refused source counts as no
  source and leaves the details fields as they were. The lyrics are read through the
  core as soon as they are picked, and invalid lyrics get "The lyrics file is
  not valid lyrics." So problems the owner can fix show before any download
  or model run. The lyrics are stored exactly as supplied
  ([D5](decisions.md#d5-supplied-lyrics-are-authoritative--agreed)).
- The song details are editable Title, Artist and Composer fields. They start
  from the source's title, artist and composer tags, exactly as stored.
  Without a title tag, the title is the source's file name without its
  extension, as on the source check page. Picking another accepted source
  fills the fields again from its tags. Whatever the fields hold when the
  task starts is stored unchanged.
- A **Vocal role** choice of Female or Male has no default. Duets come with
  M8.
- **Make the song** is off until a source, valid lyrics, a non-empty title
  and a vocal role are all set.
  The section shows the names of the picked files, never the lyric text.
- Before the first stage, the page downloads any missing model files:
  the separator's file and the `lyric-alignment` fp32 file
  ([D30](decisions.md#d30-the-aligner-file-is-fp32--agreed),
  [the choice](reference/models.md#the-choice)).
  It checks them with the same progress bar and byte line as the model check
  page. A file that fails its check stops the task before any stage, and the
  message names the file. Kept files download nothing on later runs. The page
  passes the checked files to the task, which loads no model itself.
- The measurement chose the fp32 file
  ([results](reference/models.md#measurement-results)).
- The task runs in a Web Worker
  ([processing](architecture.md#processing)). The page shows
  the current stage's name, such as "Separating the vocals", and a progress
  bar. It shows a time left only once the stage has run 1 s and reported some
  progress. The stages are those in
  [knowledge](domain/knowledge.md#processing).
- When the owner presses **Make the song**, the page first checks the
  requirements of
  [D25](decisions.md#d25-requirements-for-making-songs--agreed). Below
  them, it says "This device cannot make songs." followed by each unmet
  requirement: "WebGPU is not available." when the browser gives no GPU
  adapter, and "It has less than 8 GB of memory." when
  `navigator.deviceMemory` is below 8. A browser that does not report
  `deviceMemory` passes the memory check. Nothing is downloaded and no task
  starts. A task never runs its models on WebAssembly
  ([D3](decisions.md#d3-processing-runs-on-the-device-that-asks-for-it--agreed),
  D27). A model session that cannot open on WebGPU fails its stage with the
  stage's message, such as "The song could not be made: separation failed."
- A **Cancel** button ends the worker at once and removes the task's working
  area. No song is left behind. It is on only once the task has started, not
  during the model downloads, which cannot be stopped partway. Closing or reloading the page also ends the
  task, and the next start removes its area.
- When another tab holds the `lyre-task` lock, the page says "Another tab is
  making a song." and does not start. It checks the lock after the
  requirements and before any download, so nothing is downloaded, no stage
  runs and no working area is made. If another tab takes the lock during a
  download, the task's own check shows the same message.
- Next the page checks that the device keeps the owner's recovery public key.
  The client keeps it in `localStorage` under `lyre-recovery-public-key`, as
  base64url of its 33-byte compressed form. The
  [Recovery key section](#recovery-key) writes it. Making a song only reads it. With no key, or an entry
  that is not base64url or not 33 bytes long, the page says "Create a recovery
  key before making your first song." and does not start. Nothing is
  downloaded and no passkey is created
  ([D31](decisions.md#d31-song-files-are-encrypted-shared-and-recovered-with-one-scheme--agreed)).
- Then the page waits for this page load's device unlock, which the
  [This device section](#device-code) and the Player share, and shows
  "Waiting for this device to unlock…" with Make the song off. A device that
  gets no device code, because the passkey has no PRF, can sync, was cancelled
  or failed, sees "This device has no device code, so it cannot make songs."
  Nothing is downloaded and no task starts. The checks run in this order:
  requirements, task lock, recovery key, unlock, downloads
  ([D6](decisions.md#d6-a-song-opens-only-on-the-devices-it-was-shared-with--agreed)).
- The task writes version 1, encrypted for this device's device code and the
  owner's recovery public key. It hands over the song file and the owner's
  access file for this device. The content key never leaves the core.
- A failure shows one alert that names the stage: "The song could not be
  made: alignment failed." The stage is named as reading the source,
  extracting the audio, separation, alignment, laying out the lyrics,
  packaging the media or writing the song file. A failure before any stage
  shows "The song could not be made." No song is kept or offered. A syllable
  the aligner cannot time is named by its lyric line and position, both
  counted from 1, such as "Syllable 3 of lyric line 1 could not be timed."
  ([knowledge](domain/knowledge.md#processing)). The page never shows lyric
  text or the core's own text.
- After a cancel or a failure, the picked files, the song details and the
  vocal role stay, so the owner can start again at once. A task always starts
  again from the beginning.
- A finished song opens in the Player with its access file, as if the owner
  had opened both files. The [library](#library) keeps the song with that
  access file.
- Two download links are offered as well. **Download the song file** is named
  after the source file with `.lyre` in place of its extension. **Download
  the access file** is named the same way with `.lyrekey`. A new run, a
  cancelled run and a failed run offer neither.
- Two query parameters exist only for the journeys, as on the check pages.
  `?model=test` makes the task use the test separator and the test aligner.
  `?backend=wasm` skips the requirements check and makes the task run its
  models on WebAssembly. Without it, a task runs its models on WebGPU only.
- The section's code loads only when the owner first uses it, so it stays out
  of the main page's initial load, as the check pages' code does.

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
- A group shows at the later of two times: 4 s before its first syllable
  starts, and the end of the last syllable of the group before it. The first
  group shows 4 s before its first syllable, or from media time 0 if that is
  earlier. A group hides when its last syllable ends, unless it is the last
  group, which stays up. Until a group shows, and in the gap after the group
  before it ends, both rows are empty. Its first two display lines show
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

## Device code

- The main page has a **This device** section, under the Player. Its
  **Show the device code** button unlocks the device's own passkey. The page
  does not unlock it on load, because browsers, Safari among them, ask for a
  passkey only after a user gesture.
- The first press creates a passkey on this device, with PRF
  ([D8](decisions.md#d8-device-keys-are-bound-to-the-device-not-the-apps-storage--agreed)).
  A passkey that can sync is refused at once, by its backup flags.
- Each press asks for the device's unlock and passes the PRF output straight
  to the core, which makes the device key
  ([devices and access](architecture.md#devices-and-access)). The page then
  wipes the buffer. Within one page load, later presses reuse the key and ask
  for no unlock. The Player and Make the song share this unlock: opening a
  version-1 song, making one or restoring songs asks for no second unlock
  after a press, and a press asks for none after a song opened or was made. The page asks the passkey with the fixed Lyre PRF salt, so a
  reload shows the same device code.
- The page keeps two non-secret entries in `localStorage`. The first is the
  passkey's credential ID, and only once that passkey has given a device key.
  The ID holds no key. If the passkey gives no PRF output, or turns out to be
  able to sync, the page removes the ID. The second is the recovery public key
  under `lyre-recovery-public-key`, which the
  [Recovery key section](#recovery-key) writes, and a
  [restore](#restoring-songs) may write. This section only reads it,
  to make songs ([Making a song](#making-a-song)).
- Once the device is unlocked, the section shows the device code as text,
  labelled "Device code", the fingerprint, labelled "Fingerprint", and the QR
  code as an image named "QR code of the device code". The core makes all
  three. The QR settings are in the
  [reference](reference/device-access.md#device-code).
- The QR code is black on white with a quiet zone of four modules, whatever
  the theme. The site follows the system's dark mode, and light cells on a
  dark ground are unreadable to many scanners. This is an exception to the
  [theming](#theming) rules.
- A **Copy the device code** button puts exactly the shown code on the
  clipboard. A line then says "The device code is copied." or, when the
  browser refuses the write or has no clipboard API, "The browser refused to
  copy the device code."
- A browser whose passkey returns no PRF output, or a passkey that can sync,
  gets one plain message that says why, and no device code, QR code or copy
  button:
  - "This browser cannot give this device a device code, because its passkeys
    return no PRF output."
  - "This device gets no device code, because its passkey can sync to other
    devices."
  - "This device could not be unlocked, so it has no device code." This is for
    a cancelled unlock, a missing passkey or any other failure. The page never
    shows the browser's own error text.
- *(planned for M4)* The Android app shows the code, the fingerprint and the
  QR code the same way. A failed attestation check shows "This device gets no
  device code, because it cannot keep its key in secure hardware." Any other
  failure to make the key shows "This device could not make its key, so it has
  no device code."
- A web page cannot delete a passkey. A passkey refused for having no PRF or
  for syncing stays on the device until the user deletes it in the device's
  passkey settings.
- The Playwright journeys use Chromium's virtual authenticator. They check
  the code, the same code after a reload, the two refusals, the copy action
  and that no encoding of the PRF output reaches the page, its storage or the
  console. They do not prove behaviour on real phones or Apple devices.

## Recovery key

- The main page has a **Recovery key** section, under This device. It
  explains in a line what the key is for, and its **Create a recovery key**
  button makes the key in the core
  ([devices and access](architecture.md#devices-and-access)). Every state
  shows the warning "If you lose every device and your recovery key, your
  songs cannot be opened again."
  ([what the protection does not do](domain/knowledge.md#what-the-protection-does-not-do)).
- After the press, the section shows the 24 words as a numbered list named
  "Recovery words", and the QR code as an image named "QR code of the recovery
  key". A line asks the owner to write the words down, or print the QR code,
  and keep them offline. An **I have kept my recovery key** button confirms.
  The page does not quiz the owner on the words.
- The QR code is drawn like the [device code's](#device-code): black on white
  with a quiet zone of four modules, whatever the theme. It is an exception to
  the [theming](#theming) rules. Its settings are in the
  [reference](reference/device-access.md#words-and-qr-content).
- The page keeps the public key only when the owner confirms. Then it writes
  the 33-byte compressed key to `localStorage` under
  `lyre-recovery-public-key`, as base64url, and removes the words and the QR
  code for good. A reload, or a tab closed before the confirmation, keeps
  nothing, and the next visit makes a fresh key. The words and the QR code are
  never stored or logged.
- Once a key is kept, the section says "This device keeps your recovery key's
  public part. Every song you make can be recovered with your recovery key."
  and offers no button. It offers no way to replace the key, because older
  songs are wrapped only for the old one. The write refuses to replace a kept
  key. If two tabs show a key at once, the first to confirm wins. The other
  tab, and any tab that shows words when the key is kept, drops its words and
  says "Another tab already kept a recovery key on this device. The words shown
  here were dropped. Keep the recovery key from that tab."
- The words and the QR code live only in the section's one state value. They
  leave it when the owner confirms, when storage refuses the key, and when
  another tab keeps a key.
- If the browser refuses the write, the section says "The recovery key could
  not be kept on this device." and offers the create button again. An error
  while making the key shows the same line. The page never shows the error's
  own text.
- Making a song still refuses until a key is kept
  ([Making a song](#making-a-song)). Every song made after that is wrapped for
  it.
- A restore on a new device can also write the key
  ([Restoring songs](#restoring-songs)).
- The Playwright journeys create a key and check the 24 words and the QR
  image, that a confirmation and a reload remove them, and that a reload
  without a confirmation keeps nothing. They check that `localStorage` holds
  only the 44-character public key, that `sessionStorage`, cookies and
  IndexedDB stay empty, and that the words, in any case or in any run of three,
  reach neither the page, its storage nor the console. A core test through the
  WebAssembly API checks that a song written for the new public key is
  recovered from the words.

## Restoring songs

- The main page has a **Restore songs** section, under Recovery key. On a new
  device the owner types the 24 recovery words, or pastes the text of the
  recovery key's QR code from any scanner app, as Share takes a device code.
  Lyre has no camera scanner. The words go in a field named "Recovery words".
  The core reads typed and pasted words the same way
  ([reference](reference/device-access.md#words-and-qr-content)).
- A **Choose song files** button picks one or more `.lyre` files, and a line
  counts them. A **Restore the songs** button starts the restore and is
  disabled while it runs.
- The core reads the words first. Words it refuses get one alert, "These are
  not the 24 words of a recovery key. Check each word and try again." No file
  is read, nothing is restored, and the device is not asked to unlock.
- Then the device unlocks, with the same unlock as the Player
  ([Device code](#device-code)). If it cannot, one alert says "This device
  could not be unlocked, so no song was restored."
- For each file, the core opens the song's recovery wrap with the words and
  makes an owner access file for this device. The page opens the song with
  that file and keeps both in the [library](#library), like a song made on
  this device. The song plays from the library and offers Share.
- A list named "Restore results" gives one line for each file, in the order
  chosen: "<name>: restored", or "<name>: not restored. This file does not
  open with this recovery key." Every failure of one file gives the same
  line: a song made with another recovery key, a version-0 song, a damaged
  file and a file that is not a song file.
- A file is kept in the library even when this browser cannot play its media.
  The Player gives the reason when the owner plays it.
- When a restore opens at least one song and the device keeps no recovery
  public key, it writes the key's public part under `lyre-recovery-public-key`,
  and the Recovery key section moves to its kept state. Songs made on this
  device are then wrapped for the same recovery key. A restore never replaces a
  key that is already kept. A restore that opens no song keeps none.
- The page empties the words field as soon as the owner presses Restore. The
  words go only to the core. They are never stored, shown again or logged, and
  an error's own text is never shown. Clearing is best effort, because the
  JavaScript engine may keep copies.
- The Playwright journeys make a recovery key and two songs on one device. On
  a new device they restore both with the words, and check that both are in
  the library, play and offer Share, and that the new device keeps the same
  public key. They check that changed words give one alert and keep nothing.
  They check that a song made with a thrown-away key and a version-0 song are
  listed as not restored while the owner's song is restored. They check that
  the words, in any run of three, reach neither the page, its storage nor the
  console.

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)), the task
  check page at `#/task-check`, the source check page at
  `#/source-check`, the model check page at `#/model-check` and the
  separation check page at `#/separation-check`.
- The task check page runs a task of test stages, with its progress and a
  Cancel button. The Playwright journeys use it to check cancel and the
  cleanup after a reload ([processing](architecture.md#processing)).
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
  "This source's audio could not be packaged for a song." A **Choose a
  karaoke track** button picks a second audio file that stands in for the
  karaoke track, so the page makes the tracks without separation. Once one is picked, a **Make the
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
  thumbnail, and writes a version-1 song file through the core, in pieces
  into a working area, in a Web Worker. Before it makes anything, the button
  checks that this browser can encode Opus, then for the owner's recovery
  public key, then waits for this page load's device unlock. A missing key or
  device code gets the same message as
  [Making a song](#making-a-song), and no worker starts. The song file is
  encrypted for this device's code and the recovery public key. The song's title, artist and
  composer are the source's tags, exactly as stored. Without a title tag, the
  title is the source's file name without its extension. The lyrics are stored exactly as supplied (D5). The
  page then shows a **Download the song file** link, named after the source
  file with `.lyre` in place of its extension. A **Download the access
  file** link follows it, named after the source file with `.lyrekey`. The
  Player under the links plays the made song with its access file, and nothing
  is kept in the library. Each
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
  A **Run the test separator** button checks the one test separator file, runs
  one segment of silence in a Web Worker, and says which backend ran and the
  shape of the `stems_spec` output, 1×4×1025×801. Adding `?backend=wasm` to the URL, as in
  `#/model-check?backend=wasm`, makes it run on WebAssembly even when the
  browser has a GPU. The Playwright journeys use it to check the run without
  a GPU, under the page's policy and from the site's own origin.
  An **Align test audio** control has no aligner choice: it runs the
  lyric-alignment test aligner. It has a **Force WebAssembly** checkbox, which
  starts ticked with `?backend=wasm`. The button opens a lyrics file picker, and
  picking a file times its syllables on 40 s of test audio in a Web Worker
  ([processing](architecture.md#processing)). While it runs, a
  line shows the backend and the windows done out of the total, such as
  "Aligning on WebAssembly: 1 of 2 windows done". When it ends, the line says
  "Aligned on WebAssembly: 2 of 2 windows done", and another gives the number
  of syllables timed and says that the song file timing check accepted the
  timing. A timing the check refuses gets its own message, and any other
  failure one plain message. Neither shows lyric text or error text. The
  Playwright journeys use it to check a run of the test aligner on
  WebAssembly, under the page's policy.
  Its measurement section measures the aligner files, as the
  [measurement method](reference/models.md#measurement-method) says.
  **Choose a source** and **Choose the lyrics** buttons pick the files, and
  a **Measure the aligners** button starts once a source and the lyrics are
  picked. The page goes straight to the download, and invalid lyrics show as
  a refused alignment in each result. The page downloads the
  missing model files with the same progress bar, and a file that fails
  stops the run with the message naming it. The Playwright journeys check a
  separator file with one byte changed the same way. In one Web Worker, it decodes the
  source once. Then, on WebGPU, it separates the source with the separator,
  then times the lyrics on those vocals with `lyric-alignment` fp32 and
  `lyric-alignment` int8 in turn. A model never
  switches backend during a measurement: it runs on the backend measured, or
  its result says why not. A line, which is not a status line, names the
  stage running and its backend, such as "Aligning with lyric-alignment int8 on
  WebGPU…". Each candidate gets a result per backend, named after both,
  such as "lyric-alignment int8 on WebGPU". It shows the backend, the extract,
  separate and align times, the model load time and the separator, which is
  "Mel-Band RoFormer (Kim)", or "Test separator" with `?model=test`. It
  also shows the highest WebAssembly memory and the highest JavaScript heap seen in each
  of the three stages, in bytes. A figure the browser does not give, such as
  the heap in Firefox, shows "not reported". The extract time and memory are
  the same in every result, because the source is decoded once. The
  separate time, memory and the separator are the same in every result on one
  backend, because the source is separated once per backend. The WebAssembly
  memory never shrinks, so a stage's figure includes what earlier stages grew
  (see the [memory method](reference/models.md#memory)). A Device section
  above the results shows the browser and its version, the OS, the GPU
  adapter's vendor, architecture and description, and whether WebGPU is
  available. WebGPU counts as available only when the browser gives an
  adapter. With none, the three GPU rows show "not reported". A run that fails
  shows one reason in its result: WebGPU is not available, the model could
  not be loaded on this backend, the run ran out of memory, the separation
  failed the broken-run check (with the separation check page's message naming
  the rule and the value), the alignment was refused, the song file timing check
  refused the timing, or the run could not finish. When the separation fails
  on a backend, each candidate's result on it says "Not run." and the same
  reason. Either way the next candidate and the next backend still run. As
  soon as a separation ends, a section named after its backend, such as
  "Tracks separated on WebAssembly", shows a **Vocals** player and a
  **Karaoke track** player, so the owner can listen while the aligners still
  run. A later separation replaces the earlier one's tracks. The tracks play
  as 16-bit WAV files from the device's memory, and are never sent anywhere
  or kept. A new measurement, or leaving the page, removes the players and
  frees the tracks. Each result whose alignment finished has a **Play with
  this timing** button, whose accessible name also names the result, such as
  "Play with this timing: lyric-alignment int8 on WebAssembly". A result that
  failed or never ran has none. Pressing it makes a song in another Web
  Worker from the source and the lyrics the measurement used, the karaoke
  track of that result's backend and that result's timing
  ([D26](decisions.md#d26-the-owner-chooses-the-aligner-by-watching-its-timing-in-the-player--agreed)).
  The song's title is the source's title tag, or else the file name without
  its extension, and its vocal role is female. A line says while the song is
  being made, and a song that cannot be made gets "The song could not be made
  with this timing." A Player under the results then plays it, with its
  lyrics highlighted and the Karaoke / Original switch. Its section is named
  after the result, such as "Playing with the timing of lyric-alignment int8 on
  WebAssembly". This Player has no **Open a song file** button and no library
  list. The song is made in the device's memory, and is never kept in the
  library, downloaded or sent anywhere. Pressing another result's button
  replaces the song, and a new measurement, or leaving the page, removes the
  Player and frees the song. The page keeps each backend's karaoke track
  until then. The buttons are off while anything on the page runs, and making
  a song counts as running. A **Copy results** button below the results copies the
  Device section and every result as plain text, so the owner can record
  them in the docs. It works as soon as the Device section shows, and is off
  while a check or a measurement runs. The text has the Device section's
  title and its rows, then one block per result with the result's name and
  one "label: value" line for each row, with the values and rounding the page
  shows. Blocks are separated by a blank line. A failed run's block holds its
  reason, with "Not run." first when it never started. A line beside the
  button says "The results are copied." or "The browser refused to copy the
  results." A browser without a clipboard API counts as a refusal. A new
  measurement clears the line. Only a source without audio or an unreadable source stops the run, with the
  separation check page's messages. `?model=test` measures the test
  aligner after the test separator, and `?backend=wasm` measures only
  WebAssembly instead of WebGPU. The source and the lyrics are never sent
  anywhere. The Playwright journeys use it to check a whole measurement of
  the test aligner in Chromium with its GPU turned off, so WebGPU gives no
  adapter. Without `?backend=wasm`, each WebGPU result says WebGPU is not
  available, and nothing runs on WebAssembly. With `?backend=wasm`, each
  WebAssembly result has its figures, with a WebAssembly memory above 0 bytes
  in each stage. They check that the Vocals and Karaoke track players each
  last as long as the 2 s source. They also check the Device section with no WebGPU object
  and with a stubbed adapter, that the main
  page does not load the page's code, and that every request goes to the
  site's own origin. They also check the copied text of a measurement, and
  the message for a clipboard that refuses the write. They check that
  the results and the copied text have no accuracy rows from a hand-written
  timing, that the measurement section has no timing file button, and that
  **Measure the aligners** stays off until a source and the lyrics are
  picked. They play the test aligner's
  timing after a measurement on WebAssembly, and check that a syllable is
  highlighted, that the Karaoke / Original switch keeps the position, and
  that the library gets no new song. They also check that a measurement with
  invalid lyrics gives each result the refused alignment and no **Play with
  this timing** button.
- The separation check page separates a picked source's audio into vocals and
  a karaoke track in a Web Worker
  ([processing](architecture.md#processing)). While it runs, a
  progress bar and the status line show the backend and the segments done out
  of the total. When it ends, the page shows the backend that ran and the
  lengths of the source, the vocals and the karaoke track. A run that fails
  the broken-run check names the rule and the value it measured: the position
  of the first sample that is not finite, or the peak in dB above the source. A source without
  audio, or a file it cannot read, gets the source check page's messages, and
  a separator that cannot be loaded gets its own. The page runs Kim's Mel-Band RoFormer.
  `?model=test` runs the test separator instead, and `?backend=wasm` makes it
  run on WebAssembly, as on the model check page. The Playwright journeys use
  it to check a whole run of the test separator and that the page stays
  responsive.
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
