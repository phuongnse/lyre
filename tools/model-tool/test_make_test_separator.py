import struct
import tempfile
import unittest
from pathlib import Path

from make_test_separator import write

COMMITTED = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'models'
GRAPH = COMMITTED / 'mel-roformer.onnx'


def fields(message: bytes) -> list[tuple[int, int | bytes]]:
    """Reads a protobuf message as (field number, value) pairs, independently of the script.

    A varint field gives an int, and a length-delimited field gives its bytes.
    """
    out: list[tuple[int, int | bytes]] = []
    at = 0

    def varint() -> int:
        nonlocal at
        value, shift = 0, 0
        while True:
            byte = message[at]
            at += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if byte < 0x80:
                return value

    while at < len(message):
        key = varint()
        number, wire_type = key >> 3, key & 7
        if wire_type == 0:
            out.append((number, varint()))
        elif wire_type == 2:
            length = varint()
            out.append((number, message[at : at + length]))
            at += length
        else:
            raise ValueError(f'unexpected wire type {wire_type}')
    if at != len(message):
        raise ValueError('a field runs past the end of the message')
    return out


def every(message: bytes, number: int) -> list:
    return [value for field, value in fields(message) if field == number]


def one(message: bytes, number: int):
    values = every(message, number)
    if len(values) != 1:
        raise AssertionError(f'field {number} appears {len(values)} times')
    return values[0]


def text(message: bytes, number: int) -> str:
    return one(message, number).decode('utf-8')


def graph() -> bytes:
    return one(GRAPH.read_bytes(), 7)


def value_info(message: bytes) -> tuple[str, int, tuple[int, ...]]:
    """A ValueInfoProto's name, element type and shape."""
    tensor_type = one(one(message, 2), 1)
    dims = every(one(tensor_type, 2), 1)
    return text(message, 1), one(tensor_type, 1), tuple(one(dim, 1) for dim in dims)


class RegenerationTest(unittest.TestCase):
    def test_the_script_writes_the_committed_file_byte_for_byte(self) -> None:
        with tempfile.TemporaryDirectory() as out:
            write(Path(out))
            self.assertEqual((Path(out) / 'mel-roformer.onnx').read_bytes(), GRAPH.read_bytes())


class GraphTest(unittest.TestCase):
    def test_the_model_uses_ir_version_8_and_opset_17(self) -> None:
        model = GRAPH.read_bytes()
        self.assertEqual(one(model, 1), 8)
        opset = one(model, 8)
        self.assertEqual(text(opset, 1), '')
        self.assertEqual(one(opset, 2), 17)

    def test_the_input_and_output_are_those_of_mel_band_roformer_both_float32(self) -> None:
        inputs = [value_info(message) for message in every(graph(), 11)]
        outputs = [value_info(message) for message in every(graph(), 12)]
        self.assertEqual(inputs, [('mix_spec', 1, (1, 4, 1025, 801))])
        self.assertEqual(outputs, [('stems_spec', 1, (1, 4, 1025, 801))])

    def test_the_only_node_multiplies_the_input_by_the_scale(self) -> None:
        nodes = every(graph(), 1)
        self.assertEqual(len(nodes), 1)
        mul = nodes[0]
        self.assertEqual(text(mul, 4), 'Mul')
        self.assertEqual([value.decode('utf-8') for value in every(mul, 1)], ['mix_spec', 'scale'])
        self.assertEqual([value.decode('utf-8') for value in every(mul, 2)], ['stems_spec'])
        self.assertEqual(every(mul, 5), [])

    def test_scale_is_an_inline_float32_scalar_equal_to_0_5(self) -> None:
        (initializer,) = every(graph(), 5)
        self.assertEqual(text(initializer, 8), 'scale')
        self.assertEqual(one(initializer, 2), 1)
        self.assertEqual(every(initializer, 1), [])
        self.assertEqual(every(initializer, 13), [])
        self.assertEqual(struct.unpack('<f', one(initializer, 9)), (0.5,))


if __name__ == '__main__':
    unittest.main()
