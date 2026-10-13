import collections
import hashlib
import pickle
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from safe_load import UnsafeCheckpoint, checkpoint_globals, load_checkpoint, pickle_globals

TOOL_DIR = Path(__file__).resolve().parent


class CheckpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.torch = mock.MagicMock()
        patcher = mock.patch.dict(sys.modules, {'torch': self.torch})
        patcher.start()
        self.addCleanup(patcher.stop)

    def checkpoint(self, value: object, protocol: int) -> tuple[Path, str]:
        """Writes `value` as a PyTorch zip checkpoint and returns its path and SHA-256."""
        path = Path(self.dir.name) / f'checkpoint-{protocol}.pt'
        with zipfile.ZipFile(path, 'w') as archive:
            # fix_imports=False keeps protocol 2 from renaming builtins to __builtin__.
            archive.writestr('archive/data.pkl', pickle.dumps(value, protocol=protocol, fix_imports=False))
            archive.writestr('archive/version', '3\n')
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_a_name_outside_the_allow_list_is_refused_before_torch_load(self) -> None:
        # Protocol 2 names the function with GLOBAL, protocol 4 with STACK_GLOBAL.
        for protocol in (2, 4):
            with self.subTest(protocol=protocol):
                path, sha256 = self.checkpoint(eval, protocol)
                with self.assertRaises(UnsafeCheckpoint) as caught:
                    load_checkpoint(path, sha256, frozenset({'collections.OrderedDict'}))
                self.assertEqual(caught.exception.names, frozenset({'builtins.eval'}))
                self.torch.load.assert_not_called()

    def test_an_allowed_checkpoint_loads_with_weights_only(self) -> None:
        path, sha256 = self.checkpoint(collections.OrderedDict(), 2)
        extra = [object()]
        self.torch.load.return_value = 'state'
        state = load_checkpoint(path, sha256, frozenset({'collections.OrderedDict'}), lambda: extra)
        self.assertEqual(state, 'state')
        self.torch.serialization.safe_globals.assert_called_once_with(extra)
        self.torch.load.assert_called_once_with(path, map_location='cpu', weights_only=True)

    def test_a_legacy_checkpoint_is_refused(self) -> None:
        path = Path(self.dir.name) / 'legacy.pt'
        path.write_bytes(pickle.dumps(collections.OrderedDict(), protocol=2))
        with self.assertRaises(UnsafeCheckpoint):
            checkpoint_globals(path)


class PickleGlobalsTest(unittest.TestCase):
    def test_strings_reused_from_the_memo_are_resolved(self) -> None:
        # The second STACK_GLOBAL takes 'collections' from the memo.
        data = pickle.dumps([collections.OrderedDict, collections.Counter], protocol=4)
        self.assertEqual(pickle_globals(data), {'collections.OrderedDict', 'collections.Counter'})

    def test_a_stack_global_with_unknown_operands_is_refused(self) -> None:
        # PROTO 4, EMPTY_LIST, EMPTY_LIST, STACK_GLOBAL, STOP.
        with self.assertRaises(UnsafeCheckpoint):
            pickle_globals(b'\x80\x04]]\x93.')

    def test_the_extension_registry_is_refused(self) -> None:
        # PROTO 2, EXT1 1, STOP.
        with self.assertRaises(UnsafeCheckpoint):
            pickle_globals(b'\x80\x02\x82\x01.')


class SourceTest(unittest.TestCase):
    def test_only_the_safe_loader_loads_pickles(self) -> None:
        for path in sorted(TOOL_DIR.glob('*.py')):
            if path.name == 'safe_load.py' or path.name.startswith('test_'):
                continue
            text = path.read_text(encoding='utf-8')
            for call in ('torch.load(', 'pickle.load'):
                self.assertNotIn(call, text, f'{path.name} calls {call}')


if __name__ == '__main__':
    unittest.main()
