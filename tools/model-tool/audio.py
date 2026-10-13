"""Reads the owner's audio file for the comparisons. The audio never leaves memory."""

from pathlib import Path
from typing import Any


def load_audio(path: Path, sample_rate: int, channels: int, seconds: float | None = None) -> Any:
    """Returns the audio as a float32 tensor [channels, samples] at `sample_rate`.

    One channel mixes the file down to mono. Two channels repeat a mono file. `seconds`
    keeps only the start of the file.
    """
    import julius
    import soundfile
    import torch

    data, rate = soundfile.read(str(path), dtype='float32', always_2d=True)
    if seconds is not None:
        data = data[: int(seconds * rate)]
    if len(data) == 0:
        raise SystemExit(f'{path} holds no audio.')
    wave = torch.from_numpy(data.T.copy())
    if channels == 1:
        wave = wave.mean(dim=0, keepdim=True)
    elif wave.shape[0] == 1:
        wave = wave.repeat(channels, 1)
    elif wave.shape[0] != channels:
        raise SystemExit(f'{path} has {wave.shape[0]} channels. Give a mono or stereo file.')
    if rate != sample_rate:
        wave = julius.resample_frac(wave, rate, sample_rate)
    return wave.contiguous()
