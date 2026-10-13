"""Compares the community htdemucs ONNX file with Meta's PyTorch checkpoint, stem by stem.

    python tools/model-tool/compare_htdemucs.py --audio <file>

The ONNX file holds only htdemucs's inner network. It takes the normalised spectrogram and
waveform and returns them per stem, so the spectrogram code of the PyTorch model runs
around it. See docs/reference/model-tool.md.
"""

import argparse
import math
import sys
from pathlib import Path
from typing import Any

import pins
from audio import load_audio
from fetch import CACHE_DIR, fetch, fetch_from_hugging_face, open_verified
from safe_load import load_checkpoint

# Per stem, PyTorch's energy over the energy of the difference must be at least this.
MIN_SNR_DB = 30.0
# A stem quieter than this RMS (about -80 dBFS) in PyTorch's output is reported as silent.
SILENT_RMS = 1e-4
EXPECTED_INPUTS = ('x', 'xt')
EXPECTED_OUTPUTS = ('x_out', 'xt_out')


def extra_safe() -> list:
    """The classes outside PyTorch that the checkpoint's pickle builds.

    The training metrics hold numpy scalars, whose pickled dtype also names Float64DType.
    """
    import fractions

    import numpy
    from demucs.htdemucs import HTDemucs

    return [
        HTDemucs,
        fractions.Fraction,
        (numpy._core.multiarray.scalar, 'numpy.core.multiarray.scalar'),
        numpy.dtype,
        type(numpy.dtype(numpy.float64)),
    ]


def load_model(checkpoint: Path) -> Any:
    from demucs.states import set_state

    package = load_checkpoint(checkpoint, pins.HTDEMUCS.sha256, pins.HTDEMUCS_ALLOWED_GLOBALS, extra_safe)
    model = package['klass'](*package['args'], **package['kwargs'])
    set_state(model, package['state'])
    return model.eval()


def open_session(graph: Path, data: Path) -> Any:
    """Opens the ONNX file after checking both its graph and its weights against their pins."""
    import onnxruntime

    def session(path: Path) -> Any:
        return onnxruntime.InferenceSession(str(path), providers=['CPUExecutionProvider'])

    return open_verified(data, pins.SEPARATOR_DATA.sha256, lambda _: open_verified(graph, pins.SEPARATOR_GRAPH.sha256, session))


def describe(session: Any) -> int:
    """Prints the ONNX file's inputs and outputs, and returns its segment length in samples."""
    for kind, values in (('input', session.get_inputs()), ('output', session.get_outputs())):
        for value in values:
            print(f'ONNX {kind} {value.name}: {value.type} {value.shape}')
    inputs = tuple(value.name for value in session.get_inputs())
    outputs = tuple(value.name for value in session.get_outputs())
    if inputs != EXPECTED_INPUTS or outputs != EXPECTED_OUTPUTS:
        raise SystemExit(
            f'The ONNX file has inputs {inputs} and outputs {outputs}, '
            f'not {EXPECTED_INPUTS} and {EXPECTED_OUTPUTS}. The tool must be adapted to it.'
        )
    length = session.get_inputs()[1].shape[-1]
    if not isinstance(length, int):
        raise SystemExit('The ONNX file has no fixed segment length.')
    return length


def separate_with_onnx(model: Any, session: Any, mix: Any) -> Any:
    """Runs htdemucs on one segment with the ONNX file in place of its inner network.

    This repeats the start and end of HTDemucs.forward in demucs 4.0.1, without padding,
    because the segment already has the training length.
    """
    import torch

    length = mix.shape[-1]
    spectrum = model._spec(mix)
    magnitude = model._magnitude(spectrum)
    batch, _, bins, frames = magnitude.shape
    mean = magnitude.mean(dim=(1, 2, 3), keepdim=True)
    std = magnitude.std(dim=(1, 2, 3), keepdim=True)
    meant = mix.mean(dim=(1, 2), keepdim=True)
    stdt = mix.std(dim=(1, 2), keepdim=True)
    x, xt = session.run(
        list(EXPECTED_OUTPUTS),
        {
            'x': ((magnitude - mean) / (1e-5 + std)).numpy(),
            'xt': ((mix - meant) / (1e-5 + stdt)).numpy(),
        },
    )
    sources = len(model.sources)
    x = torch.from_numpy(x).view(batch, sources, -1, bins, frames) * std[:, None] + mean[:, None]
    from_spectrum = model._ispec(model._mask(spectrum, x), length)
    from_wave = torch.from_numpy(xt).view(batch, sources, -1, length) * stdt[:, None] + meant[:, None]
    return from_wave + from_spectrum


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--audio', type=Path, required=True, help='an audio file with music, used only for the check')
    args = parser.parse_args()
    if not args.audio.is_file():
        parser.error(f'{args.audio} is not a file.')

    import torch

    checkpoint = fetch(pins.HTDEMUCS_URL, CACHE_DIR / 'demucs' / pins.HTDEMUCS.path, pins.HTDEMUCS.sha256)
    graph = fetch_from_hugging_face(pins.SEPARATOR_REPO, pins.SEPARATOR_REVISION, pins.SEPARATOR_GRAPH)
    data = fetch_from_hugging_face(pins.SEPARATOR_REPO, pins.SEPARATOR_REVISION, pins.SEPARATOR_DATA)
    model = load_model(checkpoint)
    session = open_session(graph, data)
    segment = describe(session)
    if segment != int(model.segment * model.samplerate):
        raise SystemExit(f'The ONNX segment of {segment} samples is not the model training length.')

    audio = load_audio(args.audio, model.samplerate, channels=model.audio_channels)
    total = audio.shape[-1]
    count = math.ceil(total / segment)
    reference_energy = torch.zeros(len(model.sources), dtype=torch.float64)
    difference_energy = torch.zeros(len(model.sources), dtype=torch.float64)
    with torch.no_grad():
        for index in range(count):
            print(f'Segment {index + 1} of {count}...')
            piece = audio[:, index * segment : (index + 1) * segment]
            valid = piece.shape[-1]
            mix = torch.nn.functional.pad(piece, (0, segment - valid))[None]
            reference = model(mix)[0, ..., :valid].double()
            onnx = separate_with_onnx(model, session, mix)[0, ..., :valid].double()
            reference_energy += reference.pow(2).sum(dim=(1, 2))
            difference_energy += (reference - onnx).pow(2).sum(dim=(1, 2))

    failed = False
    samples = total * model.audio_channels
    for name, energy, difference in zip(model.sources, reference_energy.tolist(), difference_energy.tolist()):
        if math.sqrt(energy / samples) < SILENT_RMS:
            print(f'{name}: silent in this audio, not compared.')
            continue
        snr = math.inf if difference == 0 else 10 * math.log10(energy / difference)
        passes = snr >= MIN_SNR_DB
        failed |= not passes
        print(f'{name}: {snr:.1f} dB (at least {MIN_SNR_DB:.0f} dB): {"passes" if passes else "FAILS"}')
    if failed:
        print('The ONNX file does not match PyTorch closely enough.')
        return 1
    print('The ONNX file matches PyTorch on every stem compared.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
