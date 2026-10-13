import unittest

import make_aligner
from make_aligner import fp32_nodes, int8_options

ATTENTION = '/aligner/wav2vec2/encoder/layers.0/attention/q_proj/MatMul'
FEED_FORWARD = '/aligner/wav2vec2/encoder/layers.0/feed_forward/intermediate_dense/MatMul'
KEPT = [
    '/aligner/feature_transform/linear1/Gemm',
    '/aligner/feature_transform/linear2/Gemm',
    '/aligner/feature_transform/linear3/Gemm',
    '/aligner/lm_head/MatMul',
]
NODES = [
    (ATTENTION, 'MatMul'),
    (FEED_FORWARD, 'MatMul'),
    (KEPT[0], 'Gemm'),
    (KEPT[1], 'Gemm'),
    (KEPT[2], 'Gemm'),
    (KEPT[3], 'MatMul'),
    ('/aligner/lm_head/Add', 'Add'),
]


class Int8OptionsTest(unittest.TestCase):
    def test_it_quantizes_constant_weights_per_channel_to_int8(self) -> None:
        options = int8_options(NODES)
        self.assertIs(options['per_channel'], True)
        self.assertEqual(options['op_types_to_quantize'], ['MatMul', 'Gemm'])
        self.assertEqual(options['extra_options'], {'MatMulConstBOnly': True})
        self.assertNotIn('reduce_range', options)

    def test_it_keeps_feature_transform_and_the_ctc_head_in_fp32(self) -> None:
        excluded = int8_options(iter(NODES))['nodes_to_exclude']
        self.assertEqual(excluded, KEPT)
        self.assertNotIn(ATTENTION, excluded)
        self.assertNotIn(FEED_FORWARD, excluded)

    def test_it_fails_when_a_kept_layer_is_missing(self) -> None:
        for missing in ('linear1', 'linear2', 'linear3', 'lm_head'):
            with self.subTest(missing=missing):
                nodes = [node for node in NODES if f'/{missing}/' not in node[0]]
                with self.assertRaisesRegex(ValueError, missing):
                    fp32_nodes(nodes)

    def test_a_kept_layer_needs_a_matmul_or_gemm_node(self) -> None:
        nodes = [node for node in NODES if node[0] != KEPT[3]]
        with self.assertRaisesRegex(ValueError, 'lm_head'):
            fp32_nodes(nodes)


class TolerancesTest(unittest.TestCase):
    def test_the_tolerances_are_unchanged(self) -> None:
        self.assertEqual(make_aligner.FP32_MAX_DIFF, 1e-3)
        self.assertEqual(make_aligner.INT8_TOP_DIFF, 0.5)
        self.assertEqual(make_aligner.INT8_MIN_FRAMES, 0.95)


if __name__ == '__main__':
    unittest.main()
