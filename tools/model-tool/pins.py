"""Every input the model tool downloads, pinned by revision and SHA-256.

Change a pin only after downloading the new file and hashing it yourself. See
docs/reference/model-tool.md.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Pin:
    """A file in a pinned repository revision, with its SHA-256."""

    path: str
    sha256: str


def hugging_face_url(repo: str, revision: str, path: str) -> str:
    return f'https://huggingface.co/{repo}/resolve/{revision}/{path}'


# The lyric-alignment aligner (D20). Its repository has no model.safetensors, only the
# pickle checkpoint pytorch_model.bin, so the safe loader opens it.
ALIGNER_REPO = 'nguyenvulebinh/lyric-alignment'
ALIGNER_REVISION = '2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed'
ALIGNER_AUTHOR = 'nguyenvulebinh'
ALIGNER_CONFIG = Pin('config.json', 'dd48bbeef9fe203d700dc7a6b55534c136f3761a8cc19d88fcacca2e87836421')
ALIGNER_PREPROCESSOR = Pin(
    'preprocessor_config.json', '8cdfd65ff4115423185a1512bdae100e2e0cd744f5b322417429944aaafd0827'
)
ALIGNER_VOCAB = Pin('vocab.json', '4339e2cb5c97554f089fe317120e794efce3f7626ad205fb496d34bddd2c6ae7')
ALIGNER_WEIGHTS = Pin('pytorch_model.bin', '0c25b2cd0aaea6417a0ed325493300d1a46799c2e123dafd73412cafa1886123')
ALIGNER_PINS = (ALIGNER_CONFIG, ALIGNER_PREPROCESSOR, ALIGNER_VOCAB, ALIGNER_WEIGHTS)
# The Python names the aligner's pickle refers to, all of them PyTorch's own.
ALIGNER_ALLOWED_GLOBALS = frozenset(
    {
        'collections.OrderedDict',
        'torch.FloatStorage',
        'torch.LongStorage',
        'torch._utils._rebuild_tensor_v2',
    }
)

# Meta's htdemucs checkpoint (D15). Demucs names its files after the start of their SHA-256.
HTDEMUCS_URL = 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th'
HTDEMUCS = Pin('955717e8-8726e21a.th', '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4')
# The Python names the htdemucs package's pickle refers to. The ones outside PyTorch are
# also passed to the safe loader, in compare_htdemucs.py.
HTDEMUCS_ALLOWED_GLOBALS = frozenset(
    {
        '_codecs.encode',
        'collections.OrderedDict',
        'demucs.htdemucs.HTDemucs',
        'fractions.Fraction',
        'numpy.core.multiarray.scalar',
        'numpy.dtype',
        'torch.HalfStorage',
        'torch._utils._rebuild_tensor_v2',
    }
)

# The community ONNX export of htdemucs's inner network. The graph keeps its weights in a
# second file, which must sit next to it under the name the graph gives.
SEPARATOR_REPO = 'webnn/stem-separator'
SEPARATOR_REVISION = 'b56f9e66ceffca2401f83d2469dadaddd06e4994'
SEPARATOR_GRAPH = Pin('onnx/htdemucs_fwd.onnx', '555f511fb653348a1c9495ab6b6091767d1920798f3fba68629a1fe5b135a45f')
SEPARATOR_DATA = Pin(
    'onnx/htdemucs_fwd.onnx.data', '23a7c68669c041363caaef94641e961dc8c4e16b9891cb87f58f0e199a5e8820'
)
