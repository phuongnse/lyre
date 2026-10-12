# UI conventions

Both clients share one design language. The screens are not identical, but
colour, type, shape and behaviour feel the same. This follows
[D19](decisions.md#d19-web-client-on-angular-both-clients-on-material-3--agreed).

The web client follows these rules from its Angular rebuild *(planned for
M1)*. The Android app follows them from M4.

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

## Theming

- Use only Material 3 system tokens. On the web these are the `--mat-sys-*`
  CSS variables. In Compose they are `MaterialTheme.colorScheme`,
  `typography` and `shapes`.
- Put no hard-coded colours, font sizes, radii or spacing values in
  components.
- All tokens come from one seed colour.
- Open point: the owner picks the seed colour before the Angular rebuild is
  planned.
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
- On the web, a `requestAnimationFrame` loop reads the media time. It sets a
  CSS variable, the sweep progress, on the active display line. It never
  causes a re-render or a signal update per frame.
- In Compose *(planned for M4)* the idea is the same. Read the frame time in
  the draw phase, so nothing recomposes per frame.
- The highlight goes syllable by syllable. See
  [why](domain/knowledge.md#lyrics).

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)).
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
