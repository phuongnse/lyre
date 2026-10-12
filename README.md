# Lyre

Lyre turns a video or audio file and its exact lyrics into a karaoke song,
and plays it. It separates the vocals from the music, times every syllable
against the singing and highlights the lyrics as they are sung, with a switch
between the karaoke track and the original.

Everything runs on the user's own device: in the browser, or in the native
Android app. Each song is one encrypted `.lyre` file that opens only on the
devices its owner shared it with.

## Status

Lyre is in early development. The [roadmap](docs/roadmap.md) says what each
milestone delivers and its status.

## Documentation

| Document | Purpose |
| --- | --- |
| [Product brief](docs/product-brief.md) | What Lyre is, who uses it, the first journey |
| [Decisions](docs/decisions.md) | Decisions agreed or proposed, with reasons |
| [Architecture](docs/architecture.md) | The core, the clients, the song file, devices and access, testing |
| [Song file format v0](docs/reference/song-file-format-v0.md) | The byte layout of development song files |
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
- Web: TypeScript, Angular, Angular Material, ONNX Runtime Web on WebGPU.
- Android: Kotlin, Jetpack Compose, Media3, ONNX Runtime for Android.
