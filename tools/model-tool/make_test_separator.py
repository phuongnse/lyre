"""Writes the test separator: a tiny stand-in for the htdemucs ONNX files, for tests only.

    python3 tools/model-tool/make_test_separator.py [<out-dir>]

Writes htdemucs_fwd.onnx and htdemucs_fwd.onnx.data, by default to tests/fixtures/models/.
The graph has the inputs and outputs of the pinned htdemucs export. Each output holds four
copies of its input, one per stem, each multiplied by 0.25, so the stems add back up to the
input. The 0.25 is the only weight, and it is kept in the weights file, so the test separator
loads as the real one does. It is not a model: it separates nothing.

It needs only Python's standard library, and every run writes the same bytes.
See docs/reference/model-tool.md.
"""

import argparse
import hashlib
import struct
import sys
from pathlib import Path

GRAPH_NAME = 'htdemucs_fwd.onnx'
# The graph names its weights file, as the real graph does.
WEIGHTS_NAME = 'htdemucs_fwd.onnx.data'
DEFAULT_OUT_DIR = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'models'

# The inputs and outputs of the pinned htdemucs export (docs/reference/models.md#htdemucs).
STEMS = 4
INPUTS = {'x': (1, 4, 2048, 336), 'xt': (1, 2, 343_980)}
OUTPUTS = {'x_out': (1, 16, 2048, 336), 'xt_out': (1, 8, 343_980)}
SCALE = 0.25

IR_VERSION = 8
OPSET_VERSION = 17
# onnx.proto's TensorProto.DataType.FLOAT, AttributeProto.AttributeType.INT and
# TensorProto.DataLocation.EXTERNAL.
FLOAT = 1
ATTRIBUTE_INT = 2
EXTERNAL = 1

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


def _node(op_type: str, inputs: list[str], output: str, axis: int | None = None) -> bytes:
    """A NodeProto, with an `axis` attribute when one is given."""
    message = b''.join(_string(1, name) for name in inputs)
    message += _string(2, output)
    message += _string(3, output)
    message += _string(4, op_type)
    if axis is not None:
        attribute = _string(1, 'axis') + _int(3, axis) + _int(20, ATTRIBUTE_INT)
        message += _bytes(5, attribute)
    return message


def _value_info(name: str, shape: tuple[int, ...]) -> bytes:
    """A ValueInfoProto for a float32 tensor of this shape."""
    dims = b''.join(_bytes(1, _int(1, size)) for size in shape)
    tensor_type = _int(1, FLOAT) + _bytes(2, dims)
    return _string(1, name) + _bytes(2, _bytes(1, tensor_type))


def _scale_initializer() -> bytes:
    """The scalar TensorProto `scale`, stored in the weights file."""
    entries = [('location', WEIGHTS_NAME), ('offset', '0'), ('length', str(len(weights_bytes())))]
    message = _int(2, FLOAT)
    message += _string(8, 'scale')
    message += b''.join(_bytes(13, _string(1, key) + _string(2, value)) for key, value in entries)
    message += _int(14, EXTERNAL)
    return message


def graph_bytes() -> bytes:
    """The ONNX ModelProto of the test separator."""
    nodes = []
    for (name, _), out in zip(INPUTS.items(), OUTPUTS):
        quarter = f'{name}_quarter'
        nodes.append(_node('Mul', [name, 'scale'], quarter))
        nodes.append(_node('Concat', [quarter] * STEMS, out, axis=1))
    graph = b''.join(_bytes(1, node) for node in nodes)
    graph += _string(2, 'test-separator')
    graph += _bytes(5, _scale_initializer())
    graph += b''.join(_bytes(11, _value_info(name, shape)) for name, shape in INPUTS.items())
    graph += b''.join(_bytes(12, _value_info(name, shape)) for name, shape in OUTPUTS.items())
    opset = _string(1, '') + _int(2, OPSET_VERSION)
    return _int(1, IR_VERSION) + _string(2, 'lyre-test-separator') + _bytes(7, graph) + _bytes(8, opset)


def weights_bytes() -> bytes:
    """The weights file: `scale` as one little-endian float32."""
    return struct.pack('<f', SCALE)


def write(out_dir: Path) -> None:
    """Writes the graph and its weights file to `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / GRAPH_NAME).write_bytes(graph_bytes())
    (out_dir / WEIGHTS_NAME).write_bytes(weights_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out_dir', nargs='?', type=Path, default=DEFAULT_OUT_DIR, help='the folder to write to')
    args = parser.parse_args()
    write(args.out_dir)
    for name in (GRAPH_NAME, WEIGHTS_NAME):
        data = (args.out_dir / name).read_bytes()
        print(f'{name}: {len(data)} bytes, SHA-256 {hashlib.sha256(data).hexdigest()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
