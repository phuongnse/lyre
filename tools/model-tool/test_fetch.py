import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fetch import HashMismatch, fetch, open_verified


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class OpenVerifiedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.file = Path(self.dir.name) / 'weights.bin'
        self.file.write_bytes(b'changed weights')

    def test_a_file_that_differs_from_its_pin_is_refused_and_deleted(self) -> None:
        opener = mock.Mock()
        with self.assertRaises(HashMismatch) as caught:
            open_verified(self.file, sha256(b'pinned weights'), opener)
        opener.assert_not_called()
        self.assertFalse(self.file.exists())
        self.assertEqual(caught.exception.expected, sha256(b'pinned weights'))
        self.assertEqual(caught.exception.actual, sha256(b'changed weights'))

    def test_a_file_that_matches_its_pin_is_opened(self) -> None:
        opener = mock.Mock(return_value='opened')
        self.assertEqual(open_verified(self.file, sha256(b'changed weights'), opener), 'opened')
        opener.assert_called_once_with(self.file)


class FetchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        root = Path(self.dir.name)
        self.source = root / 'source.bin'
        self.source.write_bytes(b'pinned weights')
        self.url = self.source.as_uri()
        self.dest = root / 'cache' / 'weights.bin'

    def test_a_download_that_differs_from_its_pin_leaves_no_file(self) -> None:
        with self.assertRaises(HashMismatch):
            fetch(self.url, self.dest, sha256(b'other weights'))
        self.assertEqual(list(self.dest.parent.iterdir()), [])

    def test_a_download_that_matches_its_pin_is_kept(self) -> None:
        self.assertEqual(fetch(self.url, self.dest, sha256(b'pinned weights')), self.dest)
        self.assertEqual(self.dest.read_bytes(), b'pinned weights')

    def test_a_changed_cached_file_is_downloaded_again(self) -> None:
        self.dest.parent.mkdir()
        self.dest.write_bytes(b'changed weights')
        fetch(self.url, self.dest, sha256(b'pinned weights'))
        self.assertEqual(self.dest.read_bytes(), b'pinned weights')


if __name__ == '__main__':
    unittest.main()
