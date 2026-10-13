import struct
import tempfile
import unittest
from pathlib import Path

from make_test_separator import write

COMMITTED = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'models'
GRAPH = COMMITTED / 'htdemucs_fwd.onnx'
WEIGHTS = COMMITTED / 'htdemucs_fwd.onnx.data'


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
    def test_the_script_writes_the_committed_files_byte_for_byte(self) -> None:
        with tempfile.TemporaryDirectory() as out:
            write(Path(out))
            self.assertEqual((Path(out) / 'htdemucs_fwd.onnx').read_bytes(), GRAPH.read_bytes())
            self.assertEqual((Path(out) / 'htdemucs_fwd.onnx.data').read_bytes(), WEIGHTS.read_bytes())


class GraphTest(unittest.TestCase):
    def test_the_model_uses_ir_version_8_and_opset_17(self) -> None:
        model = GRAPH.read_bytes()
        self.assertEqual(one(model, 1), 8)
        opset = one(model, 8)
        self.assertEqual(text(opset, 1), '')
        self.assertEqual(one(opset, 2), 17)

    def test_the_inputs_and_outputs_are_those_of_htdemucs_all_float32(self) -> None:
        inputs = [value_info(message) for message in every(graph(), 11)]
        outputs = [value_info(message) for message in every(graph(), 12)]
        self.assertEqual(inputs, [('x', 1, (1, 4, 2048, 336)), ('xt', 1, (1, 2, 343_980))])
        self.assertEqual(outputs, [('x_out', 1, (1, 16, 2048, 336)), ('xt_out', 1, (1, 8, 343_980))])

    def test_each_output_is_four_copies_of_its_input_times_scale(self) -> None:
        nodes = {}
        for node in every(graph(), 1):
            (output,) = [value.decode('utf-8') for value in every(node, 2)]
            nodes[output] = node
        self.assertEqual(len(nodes), 4)
        for name, out in [('x', 'x_out'), ('xt', 'xt_out')]:
            concat = nodes[out]
            self.assertEqual(text(concat, 4), 'Concat')
            attribute = one(concat, 5)
            self.assertEqual((text(attribute, 1), one(attribute, 3), one(attribute, 20)), ('axis', 1, 2))
            quarters = [value.decode('utf-8') for value in every(concat, 1)]
            self.assertEqual(len(quarters), 4)
            self.assertEqual(len(set(quarters)), 1)
            mul = nodes[quarters[0]]
            self.assertEqual(text(mul, 4), 'Mul')
            self.assertEqual(every(mul, 5), [])
            self.assertEqual([value.decode('utf-8') for value in every(mul, 1)], [name, 'scale'])

    def test_scale_is_float32_0_25_stored_in_the_weights_file(self) -> None:
        (initializer,) = every(graph(), 5)
        self.assertEqual(text(initializer, 8), 'scale')
        self.assertEqual(one(initializer, 2), 1)
        self.assertEqual(every(initializer, 1), [])
        self.assertEqual(every(initializer, 9), [])
        self.assertEqual(one(initializer, 14), 1)
        external = {text(entry, 1): text(entry, 2) for entry in every(initializer, 13)}
        self.assertEqual(external, {'location': 'htdemucs_fwd.onnx.data', 'offset': '0', 'length': '4'})
        self.assertEqual(struct.unpack('<f', WEIGHTS.read_bytes()), (0.25,))


if __name__ == '__main__':
    unittest.main()
