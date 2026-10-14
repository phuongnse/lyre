import json
import struct
import tempfile
import unicodedata
import unittest
from pathlib import Path

from make_test_aligners import write
from test_make_test_htdemucs import every, one, text

REPO = Path(__file__).resolve().parents[2]
COMMITTED = REPO / 'tests' / 'fixtures' / 'models'
LYRICS = REPO / 'tests' / 'fixtures' / 'song' / 'lyrics.txt'
NAMES = ['omnilingual.onnx', 'omnilingual-tokens.txt', 'lyric-alignment.onnx', 'lyric-alignment-vocab.json']


def graph(name: str) -> bytes:
    return one((COMMITTED / name).read_bytes(), 7)


def value_info(message: bytes) -> tuple[str, int, tuple[int | str, ...]]:
    """A ValueInfoProto's name, element type and shape. A named dimension reads as its name."""
    tensor_type = one(one(message, 2), 1)
    dims = every(one(tensor_type, 2), 1)
    shape = tuple(text(dim, 2) if every(dim, 2) else one(dim, 1) for dim in dims)
    return text(message, 1), one(tensor_type, 1), shape


def nodes(name: str) -> list[bytes]:
    return every(graph(name), 1)


def nodes_of(name: str, op_type: str) -> list[bytes]:
    return [node for node in nodes(name) if text(node, 4) == op_type]


def attributes(node: bytes) -> dict[str, bytes]:
    return {text(attribute, 1): attribute for attribute in every(node, 5)}


def tokens_txt() -> dict[int, str]:
    """The committed tokens.txt, by index. Each line splits at its last space, as the core reads it."""
    lines = (COMMITTED / 'omnilingual-tokens.txt').read_text(encoding='utf-8').split('\n')
    if lines[-1] != '':
        raise AssertionError('the last line does not end with a newline')
    entries = [line.rsplit(' ', 1) for line in lines[:-1]]
    return {int(index): token for token, index in entries}


def vocab_json() -> dict[str, int]:
    return json.loads((COMMITTED / 'lyric-alignment-vocab.json').read_bytes().decode('utf-8'))


def lyric_characters() -> set[str]:
    lyrics = unicodedata.normalize('NFC', LYRICS.read_text(encoding='utf-8')).lower()
    return {c for c in lyrics if not c.isspace()}


class RegenerationTest(unittest.TestCase):
    def test_the_script_writes_the_committed_files_byte_for_byte(self) -> None:
        with tempfile.TemporaryDirectory() as out:
            write(Path(out))
            self.assertEqual(sorted(path.name for path in Path(out).iterdir()), sorted(NAMES))
            for name in NAMES:
                with self.subTest(name=name):
                    self.assertEqual((Path(out) / name).read_bytes(), (COMMITTED / name).read_bytes())


class GraphTest(unittest.TestCase):
    def test_each_model_uses_ir_version_8_and_opset_17(self) -> None:
        for name in ['omnilingual.onnx', 'lyric-alignment.onnx']:
            with self.subTest(name=name):
                model = (COMMITTED / name).read_bytes()
                self.assertEqual(one(model, 1), 8)
                opset = one(model, 8)
                self.assertEqual(text(opset, 1), '')
                self.assertEqual(one(opset, 2), 17)

    def test_omnilingual_takes_x_and_gives_logits_as_wide_as_its_tokens_txt(self) -> None:
        width = len(tokens_txt())
        self.assertEqual(width, 25)
        self.assertEqual([value_info(m) for m in every(graph('omnilingual.onnx'), 11)], [('x', 1, (1, 'samples'))])
        self.assertEqual(
            [value_info(m) for m in every(graph('omnilingual.onnx'), 12)], [('logits', 1, (1, 'frames', width))]
        )

    def test_lyric_alignment_takes_input_values_and_gives_log_probs_as_wide_as_its_vocabulary(self) -> None:
        # The core adds `<s>` and `</s>` after the entries of vocab.json.
        width = len(vocab_json()) + 2
        self.assertEqual(width, 25)
        inputs = [value_info(m) for m in every(graph('lyric-alignment.onnx'), 11)]
        outputs = [value_info(m) for m in every(graph('lyric-alignment.onnx'), 12)]
        self.assertEqual(inputs, [('input_values', 1, (1, 'samples'))])
        self.assertEqual(outputs, [('log_probs', 1, (1, 'frames', width))])

    def test_each_weight_is_one_float32_per_token(self) -> None:
        for name in ['omnilingual.onnx', 'lyric-alignment.onnx']:
            with self.subTest(name=name):
                initializers = {text(tensor, 8): tensor for tensor in every(graph(name), 5)}
                self.assertEqual(sorted(initializers), ['shape', 'weights'])
                weights = initializers['weights']
                self.assertEqual(one(weights, 2), 1)
                self.assertEqual(every(weights, 1), [25])
                self.assertEqual(len(one(weights, 9)), 25 * 4)
                shape = initializers['shape']
                self.assertEqual((one(shape, 2), every(shape, 1)), (7, [3]))
                self.assertEqual(struct.unpack('<3q', one(shape, 9)), (1, 1, -1))

    def test_both_graphs_pool_frames_of_320_samples(self) -> None:
        for name in ['omnilingual.onnx', 'lyric-alignment.onnx']:
            with self.subTest(name=name):
                (pool,) = nodes_of(name, 'AveragePool')
                found = attributes(pool)
                self.assertEqual(sorted(found), ['kernel_shape', 'strides'])
                for key in ['kernel_shape', 'strides']:
                    # Type 7 is INTS.
                    self.assertEqual(one(found[key], 20), 7)
                    self.assertEqual(every(found[key], 8), [320])

    def test_only_lyric_alignment_applies_log_softmax_over_the_tokens(self) -> None:
        self.assertEqual(nodes_of('omnilingual.onnx', 'LogSoftmax'), [])
        (log_softmax,) = nodes_of('lyric-alignment.onnx', 'LogSoftmax')
        self.assertEqual(every(log_softmax, 2), [b'log_probs'])
        axis = attributes(log_softmax)['axis']
        # Type 2 is INT.
        self.assertEqual((one(axis, 3), one(axis, 20)), (2, 2))


class VocabularyTest(unittest.TestCase):
    def test_tokens_txt_has_its_blank_at_0_and_the_space_at_4(self) -> None:
        tokens = tokens_txt()
        self.assertEqual(sorted(tokens), list(range(len(tokens))))
        self.assertEqual(tokens[0], '<s>')
        self.assertEqual(tokens[4], ' ')

    def test_vocab_json_has_the_separator_first_and_its_blank_last(self) -> None:
        vocab = vocab_json()
        self.assertEqual(sorted(vocab.values()), list(range(len(vocab))))
        self.assertEqual(vocab['|'], 0)
        self.assertEqual(vocab['<pad>'], len(vocab) - 1)

    def test_both_vocabularies_cover_every_character_of_the_fixture_lyrics(self) -> None:
        characters = lyric_characters()
        self.assertTrue(characters)
        self.assertLessEqual(characters, set(tokens_txt().values()))
        self.assertLessEqual(characters, set(vocab_json()))

    def test_every_token_is_nfc(self) -> None:
        for token in list(tokens_txt().values()) + list(vocab_json()):
            self.assertEqual(unicodedata.normalize('NFC', token), token)


if __name__ == '__main__':
    unittest.main()
