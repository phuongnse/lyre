# Models

This doc lists every model file Lyre downloads, pinned as
[D21](../decisions.md#d21-pinned-model-files-and-the-separator-target--agreed)
agreed, and says what each model takes and gives. It also sets how the
[model measurement page](../roadmap.md#early-checks-on-real-devices) judges
them.

The terms in this doc are defined in the [concepts](../domain/concepts.md).
Why these models were chosen is in
[D15](../decisions.md#d15-models-for-separation-and-alignment--agreed),
[D20](../decisions.md#d20-non-commercial-models-are-allowed-and-m2-compares-two-aligners--agreed),
[D21](../decisions.md#d21-pinned-model-files-and-the-separator-target--agreed),
[D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)
and [D29](../decisions.md#d29-the-aligner-is-lyric-alignment--agreed).

Each file is downloaded from `https://huggingface.co/<repository>/resolve/<revision>/<path>`,
never from a branch. Bytes are the file's exact size.

## Omnilingual CTC-300M

D15's aligner, no longer a candidate (D29). It stays pinned only while the
measurement page still measures it, as sherpa-onnx's int8 export.

| Repository | Revision | Path | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `csukuangfj2/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12` | `6fc542a3b0661c8278cca1230c34deb989f31202` | `model.int8.onnx` | 365,352,120 | `e7c4e54ee4c4c47829cc6667d5d00ed8ea7bef1dcfeef0fce766f77752a2726c` |
| `csukuangfj2/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12` | `6fc542a3b0661c8278cca1230c34deb989f31202` | `tokens.txt` | 86,423 | `a7a044c52cb29cbe8b0dc1953e92cefd4ca16b0ed968177b6beab21f9a7d0b31` |

- **Licence:** Apache-2.0, in the repository's `LICENSE` file. The model card
  states no licence field.
- **Attribution:** Omnilingual ASR by Meta
  ([facebookresearch/omnilingual-asr](https://github.com/facebookresearch/omnilingual-asr)),
  converted to ONNX and quantized to int8 by Fangjun Kuang for sherpa-onnx,
  with [`export-onnx.py`](https://github.com/k2-fsa/sherpa-onnx/blob/6e7ea3e409f90aaf1541c87f21a013c4f20b9680/scripts/omnilingual-asr/export-onnx.py).
  [The files at the pinned commit](https://huggingface.co/csukuangfj2/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/tree/6fc542a3b0661c8278cca1230c34deb989f31202).
- **Sample rate:** 16 kHz.
- **Channels:** mono.
- **Input:** `x`, shape (1, samples), float32.
- **Input normalisation:** outside the file, so Lyre does it. Samples in
  [−1, 1] are brought to zero mean and unit variance over the window:
  (x − mean) / √(variance + 1e-5), where the variance divides by the number
  of samples. This is what sherpa-onnx does, in
  [`offline-omnilingual-asr-ctc-model.cc`](https://github.com/k2-fsa/sherpa-onnx/blob/6e7ea3e409f90aaf1541c87f21a013c4f20b9680/sherpa-onnx/csrc/offline-omnilingual-asr-ctc-model.cc)
  and [`test.py`](https://github.com/k2-fsa/sherpa-onnx/blob/6e7ea3e409f90aaf1541c87f21a013c4f20b9680/scripts/omnilingual-asr/test.py).
- **Window length:** under 40 s (D15). Lyre uses 30 s windows with 2 s of
  overlap, planned by the core.
- **Output:** `logits`, shape (1, frames, 9812), float32. These are raw
  logits: the log-softmax is outside the file.
- **Frame rate:** 50 frames per second (one frame per 320 samples).
- **Vocabulary:** the 9,812 lines of `tokens.txt`, each a token and its index.
  Index 0, `<s>`, is the CTC blank. Index 4 is the space between words.
- **Test stand-in:** tests use the
  [test aligners](model-tool.md#make_test_alignerspy) instead. Their
  Omnilingual stand-in has the same input and output names, and is pinned as
  `test-omnilingual-model` and `test-omnilingual-tokens`.

## htdemucs

D15's separator, replaced by Mel-Band RoFormer
([D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)).
It stays pinned only while the core and the web client still run it.

| Repository | Revision | Path | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `webnn/stem-separator` | `b56f9e66ceffca2401f83d2469dadaddd06e4994` | `onnx/htdemucs_fwd.onnx` | 2,385,507 | `555f511fb653348a1c9495ab6b6091767d1920798f3fba68629a1fe5b135a45f` |
| `webnn/stem-separator` | `b56f9e66ceffca2401f83d2469dadaddd06e4994` | `onnx/htdemucs_fwd.onnx.data` | 168,361,984 | `23a7c68669c041363caaef94641e961dc8c4e16b9891cb87f58f0e199a5e8820` |

- **Licence:** the model card states MIT. That is the licence of the Demucs
  code. Meta's repository states no separate grant for the weights, so Lyre
  treats the weights' licence as unclear
  ([knowledge](../domain/knowledge.md#models-and-licences)).
- **Attribution:** Demucs v4 `htdemucs` by Meta
  ([facebookresearch/demucs](https://github.com/facebookresearch/demucs)),
  checkpoint `955717e8-8726e21a.th`, converted to ONNX for the WebNN
  Developer Preview with the repository's
  `tools/convert_htdemucs_fwd_only.py`.
  [The files at the pinned commit](https://huggingface.co/webnn/stem-separator/tree/b56f9e66ceffca2401f83d2469dadaddd06e4994).
- **The weights file** must sit next to the graph under the name
  `htdemucs_fwd.onnx.data`, which the graph gives.
- **Sample rate:** 44.1 kHz.
- **Channels:** stereo.
- **Window length:** a fixed segment of 343,980 samples (7.8 s). The source's
  audio is cut into segments of this length, and the last is padded with
  silence. A segment starts every 257,985 samples, so neighbours overlap by a
  quarter, as in Demucs's `apply_model`. The segments' stems are joined with
  Demucs's triangular weights and trimmed to the source's length.
- **Inputs:** two, both float32.
  - `x`, shape (1, 4, 2048, 336): the segment's spectrogram, with the real and
    imaginary parts of each channel as separate channels. It is an STFT with
    n_fft 4096 and hop 1024, as in Demucs 4.0.1.
  - `xt`, shape (1, 2, 343980): the segment's waveform.
- **Input normalisation:** outside the file, so Lyre does it. Each input is
  normalised over the segment as (v − mean) / (std + 1e-5), with its own
  mean and standard deviation. The standard deviation divides by N − 1, as
  PyTorch's does. Undoing it multiplies by the standard deviation and adds the
  mean, without the epsilon. The core's `separation` module does these steps
  and those under **After the file**. The
  [model tool](../../tools/model-tool/compare_htdemucs.py) shows the steps.
- **Outputs:** two, both float32, with the stems in the order drums, bass,
  other, vocals.
  - `x_out`, shape (1, 16, 2048, 336): four spectrograms, one per stem, in the
    layout of `x`.
  - `xt_out`, shape (1, 8, 343980): four stereo waveforms, one per stem.
- **After the file:** Lyre undoes each output's normalisation, turns `x_out`
  back into waveforms with the inverse STFT, and adds the two branches to get
  each stem.
- **Frame rate:** about 43.07 spectrogram frames per second (44,100 / 1024).
- **Vocabulary:** none. The karaoke track is the sum of the drums, bass and
  other stems (D15).
- **Test stand-in:** tests use the
  [test separator](model-tool.md#make_test_separatorpy) instead, which has the
  same inputs and outputs and is pinned as `test-htdemucs-graph` and
  `test-htdemucs-weights`.

## Mel-Band RoFormer

The separator of
[D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed),
as the fp16 ONNX export by audiojs, which the owner publishes unchanged.

| Repository | Revision | Path | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `phuongnse/mel-roformer-kim-onnx` | `9151f81ee8e4f7dd96598dbeeb1b186b939911be` | `mel-roformer.fp16.onnx` | 464,050,097 | `adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef` |

- **Licence:** MIT, as the checkpoint's repository states in its metadata and
  the export's `LICENSE` file states.
- **Attribution:** Mel-Band RoFormer vocal model by Kimberley Jensen, from the
  Mel-Band RoFormer authors' architecture and ZFTurbo's training code, in the
  ONNX export by audiojs
  ([`audiojs/mel-roformer` at `c1aba02c00a0bee852d6754fe6ede8164f90a4b3`](https://huggingface.co/audiojs/mel-roformer/tree/c1aba02c00a0bee852d6754fe6ede8164f90a4b3)),
  published unchanged by the owner.
  [The files at the pinned commit](https://huggingface.co/phuongnse/mel-roformer-kim-onnx/tree/9151f81ee8e4f7dd96598dbeeb1b186b939911be).
- **Sample rate:** 44.1 kHz.
- **Channels:** stereo.
- **Window length:** a segment of 8 s (352,800 samples). A segment starts every
  4 s (176,400 samples). The segments' vocals are joined with linear fades of
  0.8 s (35,280 samples), with the source reflected at its ends.
- **Input normalisation:** none.
- **STFT:** outside the file, so Lyre does it. n_fft 2048, hop 441, and a Hann
  window of 2048, centred with reflect padding, not normalised. The inverse
  STFT uses the same settings.
- **In the core:** the `mel_roformer` module does the STFT, its inverse, the
  segments, the join and the broken-run check.
- **Segment edges:** the first segment has no fade-in and the last has no
  fade-out. A song of 8 s or less is not reflected at its ends. A part shorter
  than a segment is reflected when it is longer than half a segment, and
  silent otherwise. These rules follow ZFTurbo's inference code.
- **Input and output:** both have shape (1, 4, 1025, 801), holding the real
  part of the left channel, its imaginary part, the real part of the right
  channel and its imaginary part. The input is the segment's spectrogram. The
  output is the vocals' spectrogram.
- **Frame rate:** 100 spectrogram frames per second (44,100 / 441).
- **Vocabulary:** none. The karaoke track is the source minus the vocals.
- **Test stand-in:** none yet. Tests use the htdemucs test separator until the
  core and the web client switch to this file.

## lyric-alignment

The aligner of D29, as Lyre's own ONNX export, made by the
[model tool](model-tool.md#make_alignerpy). Each of the two model files, int8
and fp32, is a candidate on the measurement page.

| Repository | Revision | Path | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `phuongnse/lyric-alignment-onnx` | `ec46b2179bfbe521e22c36d0c08bd3993c63fe71` | `model.onnx` | 1,275,253,998 | `02eda699db61269dc37620d3778fb8e8f88b67a95dbd1e0e60657dfc8afb6779` |
| `phuongnse/lyric-alignment-onnx` | `ec46b2179bfbe521e22c36d0c08bd3993c63fe71` | `model.int8.onnx` | 359,796,311 | `0071840476677e53e1cd9881246a3d2890bad812096282ebe1ac1bd676c23099` |
| `phuongnse/lyric-alignment-onnx` | `ec46b2179bfbe521e22c36d0c08bd3993c63fe71` | `vocab.json` | 1,169 | `4339e2cb5c97554f089fe317120e794efce3f7626ad205fb496d34bddd2c6ae7` |

- **Licence:** CC-BY-NC-4.0, as the original model.
- **Attribution:** `nguyenvulebinh/lyric-alignment` by nguyenvulebinh,
  [at commit `2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`](https://huggingface.co/nguyenvulebinh/lyric-alignment/tree/2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed),
  converted to ONNX by Lyre's model tool. The model card credits the author.
  [The files at the pinned commit](https://huggingface.co/phuongnse/lyric-alignment-onnx/tree/ec46b2179bfbe521e22c36d0c08bd3993c63fe71).
- **Sample rate:** 16 kHz.
- **Channels:** mono.
- **Input:** `input_values`, shape (1, samples), float32: the raw samples.
- **Input normalisation:** inside the file, so Lyre passes the raw samples.
- **Window length:** under 40 s (D15). Lyre uses 30 s windows with 2 s of
  overlap, planned by the core.
- **Output:** `log_probs`, shape (1, frames, 98), float32: CTC
  log-probabilities. The log-softmax is inside the file.
- **Frame rate:** 50 frames per second (one frame per 320 samples).
- **Vocabulary:** 98 tokens. `vocab.json` is a JSON object from each token
  to its index. Its 96 entries give indexes 0 to 95, and `<s>` and `</s>`
  take 96 and 97. Index 95, `<pad>`, is the CTC blank. Index 0, `|`, is the
  space between words.
- **Test stand-in:** tests use the
  [test aligners](model-tool.md#make_test_alignerspy) instead. Their
  lyric-alignment stand-in has the same input and output names, and is pinned
  as `test-lyric-alignment-model` and `test-lyric-alignment-vocab`.

The core's `aligner` module applies each aligner's input normalisation and
log-softmax, and reads its vocabulary file. It refuses a vocabulary file
over 1 MiB, with more than 16,384 entries, with an entry over 64 bytes, with
indexes that are not 0 to n − 1 each used once, or with no blank where the
aligner keeps it.

## Checking the pins

This command checks every row of the tables above against the Hugging Face
API, at the row's revision. Run it from the repository root. It needs network
access to Hugging Face, so no check script runs it.

```sh
python3 - <<'EOF'
import hashlib, json, re, sys, urllib.request
row = re.compile(r'^\| `([^`]+)` \| `([0-9a-f]{40})` \| `([^`]+)` \| ([\d,]+) \| `([0-9a-f]{64})` \|')
rows = [m.groups() for m in map(row.match, open('docs/reference/models.md', encoding='utf-8')) if m]
ok = len(rows) == 8
for repo, rev, path, size, sha in rows:
    folder = path.rpartition('/')[0]
    api = f'https://huggingface.co/api/models/{repo}/tree/{rev}' + (f'/{folder}' if folder else '')
    entry = next(e for e in json.load(urllib.request.urlopen(api)) if e['path'] == path)
    real = (entry.get('lfs') or {}).get('oid') or hashlib.sha256(urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{rev}/{path}').read()).hexdigest()
    good = entry['size'] == int(size.replace(',', '')) and real == sha
    ok &= good
    print('ok  ' if good else 'FAIL', repo, rev, path, entry['size'], real)
print(f'{len(rows)} pinned files')
sys.exit(0 if ok else 1)
EOF
```

- It prints one line per file and the number of files. It exits with 0 when
  there are exactly eight files and all match, and with 1 otherwise.
- For a large file, the API gives the SHA-256 directly. For a small file it
  does not, so the command downloads the file and hashes it.
- To change a pin, update its row and the expected number of files in the
  same change, then run the command.

## Download hosts

Hugging Face answers a request for a pinned file with a redirect to another
host, which serves the bytes. The web client's Content Security Policy allows
downloads only from `huggingface.co` and these hosts, in its `connect-src`:

- `cas-bridge.xethub.hf.co`
- `cdn-lfs.hf.co`
- `cdn-lfs-us-1.hf.co`
- `cdn-lfs-eu-1.hf.co`
- `us.aws.cdn.hf.co`

The web client keeps the same list in `web/src/models/download-hosts.ts`, and
a unit test checks the policy against it. The hosts are how Hugging Face
works today, seen with `curl -sI` on each pinned URL. If a download is
refused by the policy, check where the URL redirects with
`curl -sI <url> | grep -i ^location`, and update the list, the policy and
this section together.

## Measurement method

The model measurement page runs the separator and each aligner file on the
owner's devices. This section says what it measures and how the results,
together with the owner's viewing in the Player, inform the choice between the
aligner's files. The results name the devices they were taken on.

For now, the measurement section of the
[model check page](../ui-conventions.md#check-pages) runs it. Each run
measures WebGPU, then one-thread WebAssembly, and does not yet report the
download time. The page's Copy results button copies the results as plain
text, for recording in these docs.

### Inputs

- **A source** and its **lyrics**.
- The owner picks them. They stay on the device: the page never uploads
  them, and they are never committed.
- The page measures a few Vietnamese songs
  ([roadmap](../roadmap.md#early-checks-on-real-devices)).

### Time

For each model file and each backend, WebGPU and one-thread WebAssembly, the
page reports:

- the time of each stage: extract audio, separate, align;
- the model's load time, apart from the stages;
- the one-time download, apart from the rest.

### Memory

The page reports memory as the browser reports it, for each stage:

- the highest WebAssembly memory seen;
- in Chromium, the highest JavaScript heap seen (`performance.memory`).

The WebAssembly figure adds up every WebAssembly memory in the measurement
worker: the core's and ONNX Runtime's. WebAssembly memory only grows, so a
stage's figure includes what earlier stages in the same worker grew. The
separate stage's memory covers opening the separator, and the align stage's
covers loading the model as well as aligning. A figure the browser does not
give is shown as "not reported". A run that failed shows no memory figures.

The page is not cross-origin isolated
([knowledge](../domain/knowledge.md#running-on-the-users-device)), so the
browser does not report total or GPU memory. The owner reads the operating
system's figure by hand when it is needed.

### Separator target

The page checks the separator target of
[D21](../decisions.md#d21-pinned-model-files-and-the-separator-target--agreed),
the listening split of [D22](../decisions.md#d22-the-separator-target-splits-lead-and-backing-vocals--agreed)
and [D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)
on each [target device](../decisions.md#d25-requirements-for-making-songs--proposed), with a song of about 4 minutes:

- **Time:** the separate stage on WebGPU takes no longer than the song lasts.
  The download and the load time do not count.
- **Memory:** the stage finishes without running out of memory.
- **Broken run:** the core fails a run when any sample of the vocals or the
  karaoke track is not finite (NaN or infinite). The karaoke track is the
  source minus the vocals, so it always adds back up to the source. The sum
  check no longer guards a run
  ([D28](../decisions.md#d28-the-separator-is-mel-band-roformer-by-kimberley-jensen--agreed)).
- **Clipping:** the core fails a run only when the vocals or the karaoke track
  peaks more than 1 dB above the source's own peak. A sample over 1.0 alone
  does not fail, because decoded loud masters already exceed it.
- **Leftover vocals:** the owner listens to the karaoke track on the model
  check page's **Karaoke track** player, which appears after each separation
  in a measurement, and records whether clear leftover lead vocals remain. Backing vocals may remain and
  are noted, not failed.

Until the web client switches to Mel-Band RoFormer, it still runs htdemucs,
which D28 replaces, through the core's `separation` module and with its sum
check: the karaoke track plus the vocals stem is compared with the source, and
the core fails a run under a provisional 10 dB.

### The choice

- **Aligner:** `lyric-alignment` ([D29](../decisions.md#d29-the-aligner-is-lyric-alignment--agreed)).
- **Candidates:** its fp32 and int8 files. The page still measures Omnilingual
  int8 until a later change removes it. That result decides nothing.
- **Runs on a device:** a candidate runs on a device when it finishes every
  measured song there on WebGPU, without an error and without running out of
  memory.
- **The rule:** among the candidates that run on every
  [target device](../decisions.md#d25-requirements-for-making-songs--proposed),
  int8 is used unless its timing looks worse than fp32's in the Player. If only
  one file runs on every target device, that file is used. The owner plays each result through **Play with this timing** on the model check
  page ([D26](../decisions.md#d26-the-owner-chooses-the-aligner-by-watching-its-timing-in-the-player--agreed),
  [D29](../decisions.md#d29-the-aligner-is-lyric-alignment--agreed)).
- **One-thread WebAssembly** results are reported for information. They do
  not decide the choice.
