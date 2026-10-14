"""Writes the test aligners: tiny stand-ins for the Omnilingual and lyric-alignment ONNX files,
for tests only.

    python3 tools/model-tool/make_test_aligners.py [<out-dir>]

Writes omnilingual.onnx with omnilingual-tokens.txt, and lyric-alignment.onnx with
lyric-alignment-vocab.json, by default to tests/fixtures/models/. Each graph has the input and
output names of its real model, and gives one output frame per 320 input samples. Each frame
holds one value per token of the graph's own vocabulary file: the frame's average sample times
a fixed weight per token. The lyric-alignment graph then applies log-softmax, as the real one
does. They are not models: they recognise nothing.

Each vocabulary holds the letters of tests/fixtures/song/lyrics.txt, lowercase, with the word
separator and the special tokens where the real files have them.

It needs only Python's standard library, and every run writes the same bytes.
See docs/reference/model-tool.md.
"""

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

from make_test_htdemucs import _bytes, _int, _string

DEFAULT_OUT_DIR = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'models'
OMNILINGUAL_GRAPH = 'omnilingual.onnx'
OMNILINGUAL_TOKENS = 'omnilingual-tokens.txt'
LYRIC_ALIGNMENT_GRAPH = 'lyric-alignment.onnx'
LYRIC_ALIGNMENT_VOCAB = 'lyric-alignment-vocab.json'

# Every character of tests/fixtures/song/lyrics.txt but whitespace, lowercase and NFC, in
# code-point order. A unit test checks that they still cover the lyrics.
LETTERS = [
    'a', 'b', 'e', 'g', 'h', 'i', 'l', 'm', 'n', 'r', 's', 't', 'v',
    'ê', 'ô', 'ă', 'ơ', 'ư', 'ẹ', 'ề',
]
# Omnilingual's tokens.txt starts with these, and its word separator is the space at index 4.
OMNILINGUAL_SPECIALS = ['<s>', '<pad>', '</s>', '<unk>', ' ']
# The core adds `<s>` and `</s>` after lyric-alignment's vocab.json entries.
LYRIC_ALIGNMENT_ADDED = 2

# Both real models give one frame per 320 samples of 16 kHz audio.
STRIDE = 320

IR_VERSION = 8
OPSET_VERSION = 17
# onnx.proto's TensorProto.DataType.FLOAT and INT64, and AttributeProto.AttributeType.INT
# and INTS.
FLOAT = 1
INT64 = 7
ATTRIBUTE_INT = 2
ATTRIBUTE_INTS = 7


def tokens_txt() -> bytes:
    """Omnilingual's tokens.txt: one token and its index per line."""
    tokens = OMNILINGUAL_SPECIALS + LETTERS
    return ''.join(f'{token} {index}\n' for index, token in enumerate(tokens)).encode('utf-8')


def vocab_json() -> bytes:
    """lyric-alignment's vocab.json: `|` first, then the letters, `<unk>` and `<pad>`."""
    tokens = ['|'] + LETTERS + ['<unk>', '<pad>']
    vocab = {token: index for index, token in enumerate(tokens)}
    return json.dumps(vocab, ensure_ascii=False).encode('utf-8')


def omnilingual_width() -> int:
    return len(OMNILINGUAL_SPECIALS) + len(LETTERS)


def lyric_alignment_width() -> int:
    return len(LETTERS) + 3 + LYRIC_ALIGNMENT_ADDED


# Each message below writes its fields in field-number order, as onnx.proto numbers them.


def _attribute_int(name: str, value: int) -> bytes:
    return _string(1, name) + _int(3, value) + _int(20, ATTRIBUTE_INT)


def _attribute_ints(name: str, values: list[int]) -> bytes:
    # Each value is its own unpacked varint field, as proto2 writes a repeated int64.
    return _string(1, name) + b''.join(_int(8, value) for value in values) + _int(20, ATTRIBUTE_INTS)


def _node(op_type: str, inputs: list[str], output: str, attributes: list[bytes] | None = None) -> bytes:
    """A NodeProto named after its output."""
    message = b''.join(_string(1, name) for name in inputs)
    message += _string(2, output)
    message += _string(3, output)
    message += _string(4, op_type)
    message += b''.join(_bytes(5, attribute) for attribute in attributes or [])
    return message


def _initializer(name: str, data_type: int, dims: list[int], raw: bytes) -> bytes:
    """A TensorProto with its values in raw_data."""
    message = b''.join(_int(1, size) for size in dims)
    message += _int(2, data_type)
    message += _string(8, name)
    message += _bytes(9, raw)
    return message


def _value_info(name: str, shape: tuple[int | str, ...]) -> bytes:
    """A ValueInfoProto for a float32 tensor of this shape. A string names a dimension of any size."""
    dims = b''.join(_bytes(1, _string(2, size) if isinstance(size, str) else _int(1, size)) for size in shape)
    tensor_type = _int(1, FLOAT) + _bytes(2, dims)
    return _string(1, name) + _bytes(2, _bytes(1, tensor_type))


def graph_bytes(input_name: str, output_name: str, width: int, log_softmax: bool) -> bytes:
    """The ONNX ModelProto of a test aligner."""
    scores = 'scores' if log_softmax else output_name
    nodes = [
        _node('Reshape', [input_name, 'shape'], 'framed_input'),
        _node(
            'AveragePool',
            ['framed_input'],
            'frame_means',
            [_attribute_ints('kernel_shape', [STRIDE]), _attribute_ints('strides', [STRIDE])],
        ),
        _node('Transpose', ['frame_means'], 'frames_last', [_attribute_ints('perm', [0, 2, 1])]),
        _node('Mul', ['frames_last', 'weights'], scores),
    ]
    if log_softmax:
        nodes.append(_node('LogSoftmax', [scores], output_name, [_attribute_int('axis', 2)]))
    weights = [(index + 1) / width for index in range(width)]
    initializers = [
        _initializer('shape', INT64, [3], struct.pack('<3q', 1, 1, -1)),
        _initializer('weights', FLOAT, [width], struct.pack(f'<{width}f', *weights)),
    ]
    name = 'test-lyric-alignment' if log_softmax else 'test-omnilingual'
    graph = b''.join(_bytes(1, node) for node in nodes)
    graph += _string(2, name)
    graph += b''.join(_bytes(5, initializer) for initializer in initializers)
    graph += _bytes(11, _value_info(input_name, (1, 'samples')))
    graph += _bytes(12, _value_info(output_name, (1, 'frames', width)))
    opset = _string(1, '') + _int(2, OPSET_VERSION)
    return _int(1, IR_VERSION) + _string(2, 'lyre-test-aligner') + _bytes(7, graph) + _bytes(8, opset)


def files() -> dict[str, bytes]:
    """Every file the script writes, by name."""
    return {
        OMNILINGUAL_GRAPH: graph_bytes('x', 'logits', omnilingual_width(), log_softmax=False),
        OMNILINGUAL_TOKENS: tokens_txt(),
        LYRIC_ALIGNMENT_GRAPH: graph_bytes('input_values', 'log_probs', lyric_alignment_width(), log_softmax=True),
        LYRIC_ALIGNMENT_VOCAB: vocab_json(),
    }


def write(out_dir: Path) -> None:
    """Writes both test aligners and their vocabulary files to `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, data in files().items():
        (out_dir / name).write_bytes(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out_dir', nargs='?', type=Path, default=DEFAULT_OUT_DIR, help='the folder to write to')
    args = parser.parse_args()
    write(args.out_dir)
    for name in files():
        data = (args.out_dir / name).read_bytes()
        print(f'{name}: {len(data)} bytes, SHA-256 {hashlib.sha256(data).hexdigest()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
