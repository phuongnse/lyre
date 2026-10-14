"""Writes the test separator: a tiny stand-in for Mel-Band RoFormer, for tests only.

    python3 tools/model-tool/make_test_separator.py [<out-dir>]

Writes mel-roformer.onnx, by default to tests/fixtures/models/. The graph has the input and
output names, shapes and types of the pinned mel-roformer.fp16.onnx: `mix_spec` in and
`stems_spec` out, both float32 of shape (1, 4, 1025, 801). The output is the input times 0.5,
stored in the file itself. So the vocals it gives are half of each segment, and the karaoke
track is the other half. It is not a model: it separates nothing.

It needs only Python's standard library, and every run writes the same bytes.
See docs/reference/model-tool.md.
"""

import argparse
import hashlib
import struct
import sys
from pathlib import Path

GRAPH_NAME = 'mel-roformer.onnx'
DEFAULT_OUT_DIR = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'models'

# The inputs and outputs of the pinned Mel-Band RoFormer (docs/reference/models.md#mel-band-roformer).
INPUT = 'mix_spec'
OUTPUT = 'stems_spec'
SHAPE = (1, 4, 1025, 801)
SCALE = 0.5

IR_VERSION = 8
OPSET_VERSION = 17
# onnx.proto's TensorProto.DataType.FLOAT.
FLOAT = 1

# Protobuf wire types.
VARINT = 0
LENGTH_DELIMITED = 2


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _int(field: int, value: int) -> bytes:
    return _varint(field << 3 | VARINT) + _varint(value)


def _bytes(field: int, value: bytes) -> bytes:
    return _varint(field << 3 | LENGTH_DELIMITED) + _varint(len(value)) + value


def _string(field: int, value: str) -> bytes:
    return _bytes(field, value.encode('utf-8'))


# Each message below writes its fields in field-number order, as onnx.proto numbers them.


def _node(op_type: str, inputs: list[str], output: str) -> bytes:
    message = b''.join(_string(1, name) for name in inputs)
    message += _string(2, output)
    message += _string(3, output)
    message += _string(4, op_type)
    return message


def _value_info(name: str, shape: tuple[int, ...]) -> bytes:
    """A ValueInfoProto for a float32 tensor of this shape."""
    dims = b''.join(_bytes(1, _int(1, size)) for size in shape)
    tensor_type = _int(1, FLOAT) + _bytes(2, dims)
    return _string(1, name) + _bytes(2, _bytes(1, tensor_type))


def _scale_initializer() -> bytes:
    """The scalar TensorProto `scale`, with its value inline."""
    message = _int(2, FLOAT)
    message += _string(8, 'scale')
    message += _bytes(9, struct.pack('<f', SCALE))
    return message


def graph_bytes() -> bytes:
    """The ONNX ModelProto of the test separator."""
    graph = _bytes(1, _node('Mul', [INPUT, 'scale'], OUTPUT))
    graph += _string(2, 'test-separator')
    graph += _bytes(5, _scale_initializer())
    graph += _bytes(11, _value_info(INPUT, SHAPE))
    graph += _bytes(12, _value_info(OUTPUT, SHAPE))
    opset = _string(1, '') + _int(2, OPSET_VERSION)
    return _int(1, IR_VERSION) + _string(2, 'lyre-test-separator') + _bytes(7, graph) + _bytes(8, opset)


def write(out_dir: Path) -> None:
    """Writes the graph to `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / GRAPH_NAME).write_bytes(graph_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out_dir', nargs='?', type=Path, default=DEFAULT_OUT_DIR, help='the folder to write to')
    args = parser.parse_args()
    write(args.out_dir)
    data = (args.out_dir / GRAPH_NAME).read_bytes()
    print(f'{GRAPH_NAME}: {len(data)} bytes, SHA-256 {hashlib.sha256(data).hexdigest()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
