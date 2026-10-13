"""Downloads pinned files and opens a file only when its SHA-256 matches its pin."""

import hashlib
import shutil
import urllib.request
from pathlib import Path
from typing import Callable, TypeVar

from pins import Pin, hugging_face_url

T = TypeVar('T')

CHUNK = 1 << 20
REPO_ROOT = Path(__file__).resolve().parents[2]
# Downloads are kept here between runs, and checked again each time they are used.
CACHE_DIR = REPO_ROOT / 'artifacts' / 'models-cache'
# The files the tool makes. artifacts/ is never committed.
OUTPUT_DIR = REPO_ROOT / 'artifacts' / 'models'


class HashMismatch(Exception):
    """A file's SHA-256 differs from its pin. The file has been deleted."""

    def __init__(self, source: str, expected: str, actual: str) -> None:
        super().__init__(f'{source}: SHA-256 is {actual}, but the pin is {expected}. The file was deleted.')
        self.source = source
        self.expected = expected
        self.actual = actual


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        while chunk := file.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, dest: Path, sha256: str) -> Path:
    """Returns `dest` holding the file at `url`, downloading it unless a matching copy is cached."""
    if dest.exists():
        if sha256_of(dest) == sha256:
            return dest
        dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + '.part')
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(url) as response, part.open('wb') as file:
            while chunk := response.read(CHUNK):
                digest.update(chunk)
                file.write(chunk)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    actual = digest.hexdigest()
    if actual != sha256:
        part.unlink()
        raise HashMismatch(url, sha256, actual)
    part.replace(dest)
    return dest


def fetch_from_hugging_face(repo: str, revision: str, pin: Pin) -> Path:
    """Returns the cached copy of a file in a pinned Hugging Face revision."""
    return fetch(hugging_face_url(repo, revision, pin.path), CACHE_DIR / repo / revision / pin.path, pin.sha256)


def open_verified(path: Path, sha256: str, opener: Callable[[Path], T]) -> T:
    """Calls `opener(path)` only when the file's SHA-256 matches `sha256`. Deletes the file otherwise."""
    actual = sha256_of(path)
    if actual != sha256:
        path.unlink()
        raise HashMismatch(str(path), sha256, actual)
    return opener(path)


def copy_verified(source: Path, sha256: str, dest: Path) -> Path:
    """Copies a pinned file byte for byte, after checking it against its pin."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    return open_verified(source, sha256, lambda path: Path(shutil.copyfile(path, dest)))
