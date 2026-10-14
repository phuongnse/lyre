# Model tool

The model tool is a Python developer tool in `tools/model-tool/`. The owner
runs it by hand. It does two jobs for the
[model measurement page](../roadmap.md#early-checks-on-real-devices)
([D20](../decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)):

- It makes the ONNX files of the `nguyenvulebinh/lyric-alignment` aligner,
  which has no ONNX export of its own, and checks them against PyTorch.
- It checks the community htdemucs ONNX file, the separator Lyre used before
  [D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed), against Meta's PyTorch
  checkpoint.

A third job is for tests: it makes the
[test separator](#make_test_separatorpy), a tiny stand-in for Mel-Band
RoFormer, the [htdemucs test separator](#make_test_htdemucspy), a tiny
stand-in for the htdemucs files the web client still loads, and the
[test aligners](#make_test_alignerspy), tiny stand-ins for Omnilingual
and lyric-alignment.

No check script runs these commands. `scripts/test.sh` runs only the tool's
unit tests, which need nothing beyond Python's standard library. Three of them
rebuild the test separators and the test aligners in a temporary folder and
compare them with the committed files.

The terms in this doc are defined in the [concepts](../domain/concepts.md).

## Setting up

The tool runs on Linux and Windows, with Python 3.12 and no GPU. It has its
own virtual environment, `.venv-models/`, which is never committed:

```sh
python3.12 -m venv .venv-models
.venv-models/bin/pip install --require-hashes --no-deps -r tools/model-tool/requirements.txt
```

On Windows, use `py -3.12 -m venv .venv-models` and `.venv-models\Scripts\pip`.

- `requirements.txt` pins every package, with the hash of every file. It is
  made from `requirements.in` with uv. The command is in `requirements.in`.
- PyTorch comes as CPU-only wheels from PyTorch's own index. The default Linux
  wheels pull several GB of GPU libraries.
- `--no-deps` installs exactly the pinned list. demucs 4.0.1 declares an old
  torchaudio bound, which `overrides.txt` replaces when the list is made.
- The environment takes about 1.2 GB.

## Commands

```sh
.venv-models/bin/python tools/model-tool/make_aligner.py --audio <file>
.venv-models/bin/python tools/model-tool/compare_htdemucs.py --audio <file>
```

On Windows, use `.venv-models\Scripts\python`.

- `--audio` is an audio file the owner chooses, with singing and music. It is
  read in memory only and never copied. Never commit it.
- Downloads are kept in `artifacts/models-cache/`, and the aligner's files
  are written to `artifacts/models/`. `artifacts/` is never committed.
- Both commands exit with 0 when the ONNX files pass, and with 1 when they do
  not.

### make_aligner.py

1. It downloads the pinned files of `nguyenvulebinh/lyric-alignment`: the
   model's settings, the input settings, the vocabulary and the weights.
2. It builds the model as the author's own code does. That code adds three
   `feature_transform` layers between wav2vec2 and the CTC head. Every weight
   in the checkpoint must be used.
3. It writes `model.onnx` (fp32). The file takes raw 16 kHz mono samples and
   returns CTC log-probabilities. The input normalisation from the model card
   and the log-softmax are inside the file, so no client has to repeat them.
4. It writes `model.int8.onnx` with ONNX Runtime's dynamic quantization of the
   matrix multiplications (MatMul and Gemm) to int8. See
   [the int8 file](#the-int8-file).
5. It copies `vocab.json` byte for byte, and prints each file's size and
   SHA-256.
6. It compares both files with PyTorch on the first 30 s of the audio, as
   16 kHz mono. Lyre aligns in windows under 40 s
   ([D15](../decisions.md#d15-models-for-separation-and-alignment--agreed)).
7. Only when both pass does it write `README.md`, the model card for the
   owner's Hugging Face repository. The card credits the original model and
   its author, links it at the pinned commit, states CC-BY-NC-4.0 and says
   that the files were converted to ONNX.

A run takes about 3 GB of disk: 1.2 GB of downloads and 1.6 GB of output. It
needs about 6 GB of memory.

#### The int8 file

- **One scale per output channel.** Each output channel of a weight matrix
  gets its own int8 scale, not one scale for the whole matrix.
- **The last layers stay fp32.** The three `feature_transform` layers and the
  CTC head are not quantized. The tool picks them by their node names in the
  exported graph, and prints them. If it cannot find one of the four, it stops
  before writing the int8 file.
- **Only constant weights.** Only products with a constant weight matrix are
  quantized. Attention's products of two activations stay fp32.
- **The convolutions stay fp32,** because few ONNX Runtime backends run
  quantized convolutions.

Why: with one scale per matrix and every layer quantized, the int8 file
failed on the owner's 207 s clip. PyTorch's top token was within 0.5 on
94.7% of frames, where 95% is needed. The last layers feed the CTC output
directly, so an int8 error there moves the output most. Keeping them fp32
costs about 13 MB.

The published int8 file is 359,796,311 bytes, against 1,275,253,998 bytes
for `model.onnx`. The [models reference](models.md#lyric-alignment) pins
both.

### compare_htdemucs.py

htdemucs is no longer Lyre's separator ([D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)). The script stays until
the core and the web client switch.

1. It downloads Meta's htdemucs checkpoint `955717e8-8726e21a.th` and
   `onnx/htdemucs_fwd.onnx` from `webnn/stem-separator`, with the weights file
   next to it.
2. It cuts the audio, as 44.1 kHz stereo, into segments of the ONNX file's
   length. The last one is padded with silence.
3. It runs each segment through the PyTorch model, and through the ONNX file.
   The ONNX file holds only the inner network. So the PyTorch model's own
   spectrogram code, from demucs 4.0.1, prepares its input and turns its
   output back into the four stems.
4. For each stem it prints the match in dB. A stem that is silent in the
   audio is reported as silent and not compared.

A run takes about 0.3 GB of disk for downloads and about 6 GB of memory.

### make_test_separator.py

```sh
python3 tools/model-tool/make_test_separator.py
```

It writes the test separator, a stand-in for the
[Mel-Band RoFormer file](models.md#mel-band-roformer) that tests can load
without its 464 MB. Tests never use the real models
([testing](../architecture.md#testing)).

- It writes `mel-roformer.onnx` to `tests/fixtures/models/`, or to the folder
  given as its argument. It prints the file's size and SHA-256.
- The graph has the real file's input and output names, shapes and types:
  `mix_spec` in and `stems_spec` out, both float32 with shape (1, 4, 1025, 801).
- Its output is the input times 0.5, and the 0.5 is stored in the file. So the
  vocals are half of each segment, and the karaoke track is the other half. It
  separates nothing.
- It is one file with no weights file. The core does not pin it yet, because
  the web client still loads the htdemucs test files.
- It needs only Python's standard library, and every run writes the same
  bytes. The web unit test `web/src/separation/test-separator.spec.ts` runs the
  file on ONNX Runtime Web.

### make_test_htdemucs.py

htdemucs is no longer Lyre's separator ([D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)). The script stays until
the core and the web client switch.

```sh
python3 tools/model-tool/make_test_htdemucs.py
```

It writes the htdemucs test separator, a stand-in for the
[htdemucs files](models.md#htdemucs) that the web journeys can load without
the 170 MB real model. Tests never use the real models
([testing](../architecture.md#testing)).

- It writes `htdemucs_fwd.onnx` and `htdemucs_fwd.onnx.data` to
  `tests/fixtures/models/`, or to the folder given as its argument. It prints
  each file's size and SHA-256.
- The graph has the real file's inputs and outputs, all float32: `x`
  (1, 4, 2048, 336) and `xt` (1, 2, 343980) in, `x_out` (1, 16, 2048, 336)
  and `xt_out` (1, 8, 343980) out.
- Each output holds four copies of its input, one per stem, each multiplied
  by 0.125. So the four stems of each branch add up to half the input. The
  core adds the spectrogram and waveform branches together, so the two give
  back the input. It separates nothing.
- The 0.125 is the graph's only weight. It sits in the weights file, which the
  graph names `htdemucs_fwd.onnx.data` as the real graph does. So a client
  loads the test separator as it loads the real one.
- It needs only Python's standard library, and every run writes the same
  bytes. The core pins both files as `test-htdemucs-graph` and
  `test-htdemucs-weights`, so after changing the script, update those pins.

### make_test_aligners.py

```sh
python3 tools/model-tool/make_test_aligners.py
```

It writes the test aligners, stand-ins for the
[Omnilingual](models.md#omnilingual-ctc-300m) and
[lyric-alignment](models.md#lyric-alignment) files. The alignment journeys
can load them without the real models of several hundred MB. Tests never use
the real models ([testing](../architecture.md#testing)).

- It writes `omnilingual.onnx` with `omnilingual-tokens.txt`, and
  `lyric-alignment.onnx` with `lyric-alignment-vocab.json`, to
  `tests/fixtures/models/`, or to the folder given as its argument. It prints
  each file's size and SHA-256.
- Each graph has its real model's input and output names, all float32. The
  Omnilingual stand-in takes `x` (1, samples) and gives raw `logits`
  (1, frames, 25). The lyric-alignment stand-in takes `input_values`
  (1, samples) and gives `log_probs` (1, frames, 25).
- Both give one frame per 320 samples, as the real models do. Each frame has
  one value per token of the graph's own vocabulary.
- Each frame's values are the frame's average sample times a fixed weight
  per token. The lyric-alignment stand-in then applies log-softmax inside
  the file, as the real one does. It recognises nothing.
- The vocabularies hold the lowercase letters of
  `tests/fixtures/song/lyrics.txt`, and a unit test checks that they cover
  it. `omnilingual-tokens.txt` has `<s>`, the blank, at index 0 and the space
  at index 4. `lyric-alignment-vocab.json` has `|` at index 0 and `<pad>`, the
  blank, last. The core adds `<s>` and `</s>` after it, as for the real file.
- It needs only Python's standard library, and every run writes the same
  bytes. The core pins the four files as `test-omnilingual-model`,
  `test-omnilingual-tokens`, `test-lyric-alignment-model` and
  `test-lyric-alignment-vocab`, so after changing the script, update those
  pins.

## Pinned inputs

`tools/model-tool/pins.py` pins every file the tool downloads.

- A Hugging Face file is pinned by the repository's 40-character commit and
  by its SHA-256. It is downloaded from `resolve/<commit>`, never from a
  branch.
- Meta's checkpoint is pinned by its URL and its SHA-256. Demucs names its
  files after the start of their hash, so this one starts with `8726e21a`.
- Before the tool uses a file, downloaded or cached, it checks the file's
  SHA-256 against its pin. A file that does not match is deleted, and the tool
  stops before reading it.
- A download is written beside its final name and renamed only after its hash
  matches.
- To change a pin, download the new file, hash it yourself and update the pin
  and the allow list in the same change.

## Opening PyTorch checkpoints

PyTorch checkpoints are pickle files, and opening a pickle can run code. The
tool opens them only in `safe_load.py`, in this order:

1. The file's SHA-256 must match its pin.
2. The file must be a zip checkpoint. Older checkpoint formats are refused.
3. The tool lists every Python name the pickle refers to, without running it.
   Each name must be in that checkpoint's allow list in `pins.py`. A pickle
   whose names cannot all be read is refused.
4. Only then does PyTorch's safe loader (`weights_only=True`) read it. The
   classes it may build beyond PyTorch's own are listed by name.

No other file in the tool calls `torch.load` or loads a pickle, and a unit
test checks this.

## Tolerances

Each comparison prints its measures and fails when one is out of bounds.

| Comparison | Passes when |
| --- | --- |
| Aligner, fp32 | Every probability (any frame, any token) is within 0.001 of PyTorch's, and the most likely token is the same on every frame. |
| Aligner, int8 | On at least 95% of frames, the log-probability of PyTorch's most likely token is within 0.5 of PyTorch's value. |
| htdemucs (before D28), per stem | PyTorch's stem energy over the energy of the difference is at least 30 dB. |

- **fp32 compares probabilities, not log-probabilities.** Many tokens have a
  log-probability between −100 and −250 on a frame. Float32 rounding alone
  moves those by up to about 0.2, even between two PyTorch runs. Such a token
  has a probability that is zero in practice, so the difference cannot change
  an alignment.
- **int8 shifts every value.** Alignment depends on the likely tokens keeping
  about the same probability. 0.5 in log space is about a factor of 1.6.
- **30 dB** means the difference is about 3% of the stem's amplitude. That is
  well below anything audible in a karaoke track.

## Why `tools/model-tool/`

The tool cannot live in `tools/models/`. The `.gitignore` rule `models/`,
which keeps model weights out of the repository, ignores every folder named
`models`. The tool's source would never be committed.
