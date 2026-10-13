"""Writes the README for the Hugging Face repository that publishes the aligner's ONNX files."""

import pins


def model_card(revision: str, files: list[tuple[str, int, str]]) -> str:
    """Returns the README, given the pinned revision and each file's name, size in bytes and SHA-256."""
    source = f'https://huggingface.co/{pins.ALIGNER_REPO}'
    rows = '\n'.join(f'| `{name}` | {size:,} | `{sha256}` |' for name, size, sha256 in files)
    return f"""---
license: cc-by-nc-4.0
base_model: {pins.ALIGNER_REPO}
language: vi
library_name: onnx
tags:
- onnx
- wav2vec2
- ctc
---

# lyric-alignment, converted to ONNX

These files are the Vietnamese lyric alignment model
[`{pins.ALIGNER_REPO}`]({source}) by {pins.ALIGNER_AUTHOR}, converted to ONNX.
The conversion used the original model at commit
[`{revision}`]({source}/tree/{revision}).
All credit for the model goes to its author. This is not an official release.

## Licence

The original model is licensed under
[CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/), and so are
these files. They may not be used for commercial purposes.

## What changed

The files were converted to ONNX from the original PyTorch checkpoint. The
weights are the original ones.

- The input is raw 16 kHz mono audio samples, shape `[batch, samples]`. The
  model card's input normalisation, to zero mean and unit variance, is built
  into the file.
- The output is CTC log-probabilities, shape `[batch, frames, 98]`. The
  log-softmax is built into the file.
- The three `feature_transform` layers of the author's model code
  (`model_handling.py`) are part of the graph, before the CTC head.
- `model.int8.onnx` is made from `model.onnx` by ONNX Runtime's dynamic
  quantization of the MatMul and Gemm weights to int8, with one scale per
  output channel. The three `feature_transform` layers and the CTC head stay
  fp32, because they move the output most. The convolutions stay fp32 too.
- `vocab.json` is the original vocabulary, unchanged. Tokens 96 and 97 are
  `<s>` and `</s>`, from the original `added_tokens.json`.

## Files

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
{rows}
"""
