# Lyre

Lyre turns a video or audio file and its exact lyrics into a karaoke song,
and plays it. It separates the vocals from the music, times every syllable
against the singing and highlights the lyrics as they are sung, with a switch
between the karaoke track and the original.

Everything runs on the user's own device. Songs are made in the browser, on
a desktop or a phone, and play there or in the native Android app. Each song
is one encrypted `.lyre` file that opens only on the devices its owner shared
it with.

## Status

Lyre is in early development. The [roadmap](docs/roadmap.md) says what each
milestone delivers and its status.

A development build of the web client runs at
<https://phuongnse.github.io/lyre/>. It is updated after every change on `main`.

## Documentation

| Document | Purpose |
| --- | --- |
| [Product brief](docs/product-brief.md) | What Lyre is, who uses it, the first journey |
| [Decisions](docs/decisions.md) | Decisions agreed or proposed, with reasons |
| [Architecture](docs/architecture.md) | The core, the clients, the song file, devices and access, testing |
| [Song file format v0](docs/reference/song-file-format-v0.md) | The byte layout of development song files |
| [Song file format v1](docs/reference/song-file-format-v1.md) | The byte layout of encrypted song files, from M3 |
| [Devices and access](docs/reference/device-access.md) | The device code, fingerprint, access file and recovery key: text, bytes and what a reader rejects |
| [lyre-cli](docs/reference/lyre-cli.md) | The developer tool that builds song files from fixtures: its manifest, the timing file and the fixture song |
| [Models](docs/reference/models.md) | The pinned model files, what each model takes and gives, how the model measurement page measures them, and the results |
| [UI conventions](docs/ui-conventions.md) | How both clients build their UI: Material 3 tokens, strings, accessibility, the Player |
| [Concepts](docs/domain/concepts.md) | The Lyre vocabulary |
| [Design knowledge](docs/domain/knowledge.md) | What makes a good karaoke song and the pitfalls to avoid |
| [Roadmap](docs/roadmap.md) | Milestones, what each delivers and its status |
| [Delivery](docs/delivery.md) | How work flows through NexKit, from issue to merged pull request |

Contributors and agents start with [AGENTS.md](AGENTS.md).

## Technology

See [D10](docs/decisions.md#d10-technology-stack--agreed) and
[D19](docs/decisions.md#d19-web-client-on-angular-both-clients-on-material-3--agreed):

- Shared core: Rust, compiled to WebAssembly and to a native Android library.
- Web: TypeScript, Angular, Angular Material, ONNX Runtime Web on WebGPU,
  and Mediabunny to read and decode sources.
- Android: Kotlin, Jetpack Compose, Media3.

## Licence

The code in this repository is under the [MIT licence](LICENSE).

Data and models that Lyre uses or downloads are not part of the code and keep
their own licences. For example:

- The Vietnamese word list from Wiktionary is under CC BY-SA 4.0. See
  [its notice](core/lyre-core/src/words/wiktionary_words.NOTICE.md) and
  [D18](docs/decisions.md#d18-vietnamese-word-boundaries-from-a-word-list--agreed).
- The aligner `lyric-alignment` by nguyenvulebinh,
  [model card at commit `2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`](https://huggingface.co/nguyenvulebinh/lyric-alignment/tree/2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed).
  Lyre's model tool converted it to ONNX, and the owner publishes the export as
  `phuongnse/lyric-alignment-onnx`. It is under
  [CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/). See
  [D29](docs/decisions.md#d29-the-aligner-is-lyric-alignment--agreed) and
  [the models reference](docs/reference/models.md#lyric-alignment). Every other
  CC-BY-NC model that
  [D20](docs/decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)
  allows stays under its own licence.
- The separator Mel-Band RoFormer by Kimberley Jensen, in audiojs's ONNX
  export, is published unchanged by the owner as
  `phuongnse/mel-roformer-kim-onnx`. It is under MIT. See
  [D28](docs/decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed) and
  [the models reference](docs/reference/models.md#mel-band-roformer).

Mediabunny, which the web client uses to read and decode sources, is under
MPL-2.0. It is used unmodified from npm, and the web build ships its licence
notice in `3rdpartylicenses.txt`.

See [models and licences](docs/domain/knowledge.md#models-and-licences) for
the models Lyre uses.
