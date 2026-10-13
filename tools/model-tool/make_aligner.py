"""Makes the lyric-alignment aligner's ONNX files and checks them against PyTorch.

    python tools/model-tool/make_aligner.py --audio <file>

Writes model.onnx (fp32), model.int8.onnx, vocab.json and README.md to artifacts/models/.
The README is written only when both ONNX files pass the comparison on the owner's audio.
See docs/reference/model-tool.md.
"""

import argparse
import json
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pins
from audio import load_audio
from fetch import OUTPUT_DIR, copy_verified, fetch_from_hugging_face, open_verified, sha256_of
from model_card import model_card
from safe_load import load_checkpoint

SAMPLE_RATE = 16_000
# The comparison uses the start of the audio. Lyre aligns in windows under 40 s (D15).
CHECK_SECONDS = 30
# fp32: the largest difference in any probability, and the top token on every frame.
# Probabilities, not log-probabilities: fp32 rounding alone moves a log-probability near
# -250 by about 0.1, which changes a probability that is zero in practice.
FP32_MAX_DIFF = 1e-3
# int8: on enough frames, the log-probability of PyTorch's top token stays this close.
INT8_TOP_DIFF = 0.5
INT8_MIN_FRAMES = 0.95
# int8 quantizes the weights of these operations. One int8 scale per output channel, not one
# per matrix: a single scale lost too much on the owner's audio (94.7% of frames, not 95%).
INT8_OP_TYPES = ('MatMul', 'Gemm')
INT8_PER_CHANNEL = True
# The layers after wav2vec2 that move the output most. Kept in fp32 in the int8 file.
INT8_FP32_LAYERS = (
    '/aligner/feature_transform/linear1/',
    '/aligner/feature_transform/linear2/',
    '/aligner/feature_transform/linear3/',
    '/aligner/lm_head/',
)


def build_aligner(config: dict, state_dict: dict) -> Any:
    """Builds the author's model at inference: wav2vec2, three feature_transform blocks, CTC head.

    This repeats Wav2Vec2ForCTC from the author's model_handling.py, which is not on
    Hugging Face. Its dropouts do nothing at inference and are left out. The strict load
    fails if any weight in the checkpoint is not used, or any layer has no weight.
    """
    from collections import OrderedDict

    import torch
    from transformers import Wav2Vec2Config, Wav2Vec2Model

    class Aligner(torch.nn.Module):
        def __init__(self, config: Wav2Vec2Config) -> None:
            super().__init__()
            size = config.hidden_size
            self.wav2vec2 = Wav2Vec2Model(config)
            blocks = []
            for index in (1, 2, 3):
                blocks += [
                    (f'linear{index}', torch.nn.Linear(size, size)),
                    (f'bn{index}', torch.nn.BatchNorm1d(size)),
                    (f'activation{index}', torch.nn.LeakyReLU()),
                ]
            self.feature_transform = torch.nn.Sequential(OrderedDict(blocks))
            self.lm_head = torch.nn.Linear(size, config.vocab_size)

        def forward(self, input_values: torch.Tensor) -> torch.Tensor:
            hidden = self.wav2vec2(input_values).last_hidden_state
            batch, frames, size = hidden.shape
            hidden = self.feature_transform(hidden.reshape(batch * frames, size))
            return self.lm_head(hidden.reshape(batch, frames, size))

    model = Aligner(Wav2Vec2Config.from_dict(config))
    model.load_state_dict(state_dict, strict=True)
    return model.eval()


def exported_module(aligner: Any, do_normalize: bool) -> Any:
    """Wraps the aligner so that it takes raw samples and returns log-probabilities."""
    import torch

    class Exported(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.aligner = aligner

        def forward(self, samples: torch.Tensor) -> torch.Tensor:
            if do_normalize:
                # As Wav2Vec2FeatureExtractor does: zero mean and unit variance per clip.
                mean = samples.mean(dim=-1, keepdim=True)
                variance = samples.var(dim=-1, keepdim=True, unbiased=False)
                samples = (samples - mean) / torch.sqrt(variance + 1e-7)
            return torch.log_softmax(self.aligner(samples), dim=-1)

    return Exported().eval()


def fp32_nodes(nodes: Iterable[tuple[str, str]]) -> list[str]:
    """Returns the names of the MatMul and Gemm nodes of the layers kept in fp32.

    Takes each node's name and operation type. Fails when a layer has no such node, so that a
    change in how the exporter names nodes cannot quietly quantize every layer.
    """
    names = [name for name, op_type in nodes if op_type in INT8_OP_TYPES]
    kept = []
    for layer in INT8_FP32_LAYERS:
        found = [name for name in names if name.startswith(layer)]
        if not found:
            raise ValueError(f'No MatMul or Gemm node of {layer} in the exported graph.')
        kept += found
    return kept


def int8_options(nodes: Iterable[tuple[str, str]]) -> dict[str, Any]:
    """Returns the settings for ONNX Runtime's quantize_dynamic, given the graph's nodes."""
    return {
        'op_types_to_quantize': list(INT8_OP_TYPES),
        'per_channel': INT8_PER_CHANNEL,
        'nodes_to_exclude': fp32_nodes(nodes),
        # Only products with a constant weight. Attention's products of two activations stay fp32.
        'extra_options': {'MatMulConstBOnly': True},
    }


def export(module: Any, fp32: Path, int8: Path) -> None:
    import onnx
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic

    example = torch.randn(1, 4 * SAMPLE_RATE, generator=torch.Generator().manual_seed(0))
    with torch.no_grad():
        torch.onnx.export(
            module,
            (example,),
            str(fp32),
            dynamo=False,
            opset_version=17,
            input_names=['input_values'],
            output_names=['log_probs'],
            dynamic_axes={'input_values': {1: 'samples'}, 'log_probs': {1: 'frames'}},
        )
    graph = onnx.load(str(fp32), load_external_data=False).graph
    options = int8_options((node.name, node.op_type) for node in graph.node)
    del graph
    print(f'Kept in fp32: {", ".join(options["nodes_to_exclude"])}')
    quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8, **options)


def reference_log_probs(aligner: Any, preprocessor: dict, audio: Any) -> Any:
    """PyTorch's log-probabilities, with the input prepared by the model card's feature extractor."""
    import torch
    from transformers import Wav2Vec2FeatureExtractor

    extractor = Wav2Vec2FeatureExtractor.from_dict(preprocessor)
    inputs = extractor(audio[0].numpy(), sampling_rate=SAMPLE_RATE, return_tensors='pt').input_values
    with torch.no_grad():
        return torch.log_softmax(aligner(inputs), dim=-1)[0].numpy()


def onnx_log_probs(model: Path, audio: Any) -> Any:
    import onnxruntime

    session = onnxruntime.InferenceSession(str(model), providers=['CPUExecutionProvider'])
    return session.run(['log_probs'], {'input_values': audio.numpy()})[0][0]


def compare(reference: Any, fp32: Any, int8: Any) -> bool:
    import numpy

    if fp32.shape != reference.shape or int8.shape != reference.shape:
        print(f'Shapes differ: PyTorch {reference.shape}, fp32 {fp32.shape}, int8 {int8.shape}.')
        return False
    top = reference.argmax(axis=-1)
    frames = numpy.arange(len(top))

    fp32_max = float(numpy.abs(numpy.exp(fp32) - numpy.exp(reference)).max())
    fp32_top = int((fp32.argmax(axis=-1) == top).sum())
    fp32_ok = fp32_max <= FP32_MAX_DIFF and fp32_top == len(top)
    print(
        f'fp32: largest difference in a probability {fp32_max:.2e} (at most {FP32_MAX_DIFF:.0e}). '
        f'Largest in a log-probability {float(numpy.abs(fp32 - reference).max()):.2e}.'
    )
    print(f'fp32: same top token on {fp32_top} of {len(top)} frames (all needed).')

    int8_diff = numpy.abs(int8[frames, top] - reference[frames, top])
    int8_share = float((int8_diff <= INT8_TOP_DIFF).mean())
    int8_ok = int8_share >= INT8_MIN_FRAMES
    print(
        f"int8: PyTorch's top token within {INT8_TOP_DIFF} on {int8_share:.1%} of frames "
        f'(at least {INT8_MIN_FRAMES:.0%} needed). Largest difference {float(int8_diff.max()):.3f}.'
    )
    print(f'fp32 {"passes" if fp32_ok else "FAILS"}. int8 {"passes" if int8_ok else "FAILS"}.')
    return fp32_ok and int8_ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--audio', type=Path, required=True, help='an audio file with singing, used only for the check')
    args = parser.parse_args()
    if not args.audio.is_file():
        parser.error(f'{args.audio} is not a file.')

    paths = {pin: fetch_from_hugging_face(pins.ALIGNER_REPO, pins.ALIGNER_REVISION, pin) for pin in pins.ALIGNER_PINS}
    config, preprocessor = (
        open_verified(paths[pin], pin.sha256, lambda path: json.loads(path.read_text(encoding='utf-8')))
        for pin in (pins.ALIGNER_CONFIG, pins.ALIGNER_PREPROCESSOR)
    )
    state_dict = load_checkpoint(paths[pins.ALIGNER_WEIGHTS], pins.ALIGNER_WEIGHTS.sha256, pins.ALIGNER_ALLOWED_GLOBALS)
    aligner = build_aligner(config, state_dict)
    del state_dict

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    readme = OUTPUT_DIR / 'README.md'
    readme.unlink(missing_ok=True)
    fp32 = OUTPUT_DIR / 'model.onnx'
    int8 = OUTPUT_DIR / 'model.int8.onnx'
    vocab = copy_verified(paths[pins.ALIGNER_VOCAB], pins.ALIGNER_VOCAB.sha256, OUTPUT_DIR / 'vocab.json')
    print('Exporting to ONNX and quantizing...')
    export(exported_module(aligner, bool(preprocessor.get('do_normalize', False))), fp32, int8)

    files = [(path.name, path.stat().st_size, sha256_of(path)) for path in (fp32, int8, vocab)]
    for name, size, sha256 in files:
        print(f'{name}: {size:,} bytes, SHA-256 {sha256}')

    print(f'Comparing on the first {CHECK_SECONDS} s of {args.audio.name}...')
    audio = load_audio(args.audio, SAMPLE_RATE, channels=1, seconds=CHECK_SECONDS)
    reference = reference_log_probs(aligner, preprocessor, audio)
    if not compare(reference, onnx_log_probs(fp32, audio), onnx_log_probs(int8, audio)):
        print('The ONNX files do not match PyTorch. No README was written.')
        return 1
    readme.write_text(model_card(pins.ALIGNER_REVISION, files), encoding='utf-8', newline='\n')
    print(f'Wrote {readme}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
