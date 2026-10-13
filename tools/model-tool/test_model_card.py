import unittest

import pins
from model_card import model_card


class ModelCardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.card = model_card(
            pins.ALIGNER_REVISION,
            [('model.onnx', 1_275_253_998, 'a' * 64), ('vocab.json', 1169, 'b' * 64)],
        )

    def test_it_credits_the_original_model_and_its_repository(self) -> None:
        self.assertIn('nguyenvulebinh/lyric-alignment', self.card)
        self.assertIn('https://huggingface.co/nguyenvulebinh/lyric-alignment', self.card)
        self.assertIn(pins.ALIGNER_REVISION, self.card)
        self.assertIn('base_model: nguyenvulebinh/lyric-alignment', self.card)

    def test_it_states_the_licence(self) -> None:
        self.assertIn('license: cc-by-nc-4.0', self.card)
        self.assertIn('CC-BY-NC-4.0', self.card)

    def test_it_states_the_conversion_to_onnx(self) -> None:
        self.assertIn('converted to ONNX', self.card)
        self.assertIn('not an official release', self.card)

    def test_it_states_how_the_int8_file_is_made(self) -> None:
        text = ' '.join(self.card.split())
        self.assertIn('with one scale per output channel', text)
        self.assertIn('The three `feature_transform` layers and the CTC head stay fp32', text)

    def test_it_lists_each_file_with_its_size_and_hash(self) -> None:
        self.assertIn(f'| `model.onnx` | 1,275,253,998 | `{"a" * 64}` |', self.card)
        self.assertIn(f'| `vocab.json` | 1,169 | `{"b" * 64}` |', self.card)


if __name__ == '__main__':
    unittest.main()
