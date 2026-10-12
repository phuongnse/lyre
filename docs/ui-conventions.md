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
  components. The one exception is the
  [vocal role colours](#vocal-role-colours).
- All tokens come from one seed colour, `#6B5778` (smoky purple). The one
  exception is the [vocal role colours](#vocal-role-colours), which a seed
  change never changes.
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

## Vocal role colours

- Lyrics are coloured by [vocal role](domain/concepts.md#songs): male blue,
  female red, duet pink. This is a fixed rule *(planned for M8)*.
- The colours do not come from the seed. They are the same on the web and on
  Android.
- The lyrics backdrop is the Material 3 `scrim` system token
  (`--mat-sys-scrim`, or `MaterialTheme.colorScheme.scrim` in Compose) at 80%
  opacity, behind the lyrics over the video. The scrim is black for every seed.
- Contrast is measured against the backdrop's lightest case, `#333333`. This
  is the scrim over pure white video. Each colour needs at least 4.5:1.
  Ratios are rounded down to one decimal place.
- How the Player's highlight uses these colours is decided later.

| Vocal role | Token | Colour | Contrast against `#333333` |
| --- | --- | --- | --- |
| Male | `--lyre-vocal-male` | `#8AB4F8` (blue) | 5.9:1 |
| Female | `--lyre-vocal-female` | `#FF8A80` (red) | 5.5:1 |
| Duet | `--lyre-vocal-duet` | `#FF80AB` (pink) | 5.3:1 |

Compose uses the same three values *(planned for M4)*.

## Check pages

- Check pages keep their code out of the main app's initial load. Examples are
  the passkey check page and the model measurement page (see
  [early checks](roadmap.md#early-checks-on-real-devices)).
- Each one is a lazy-loaded route with `loadComponent`, in the same build and
  deploy as the main app. This is agreed in D19.
