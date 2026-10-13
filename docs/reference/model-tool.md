# Model tool

The model tool is a Python developer tool in `tools/model-tool/`. The owner
runs it by hand. It does two jobs for the
[model measurement page](../roadmap.md#early-checks-on-real-devices)
([D20](../decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed)):

- It makes the ONNX files of the `nguyenvulebinh/lyric-alignment` aligner,
  which has no ONNX export of its own, and checks them against PyTorch.
- It checks the community htdemucs ONNX file against Meta's PyTorch
  checkpoint.

No check script runs these commands. `scripts/test.sh` runs only the tool's
unit tests, which need nothing beyond Python's standard library.

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
   matrix multiplications (MatMul and Gemm). The convolutions stay fp32,
   because few ONNX Runtime backends run quantized convolutions.
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

### compare_htdemucs.py

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
| htdemucs, per stem | PyTorch's stem energy over the energy of the difference is at least 30 dB. |

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
