"""Opens PyTorch checkpoints, which are pickle files, without letting them run code.

A checkpoint is opened only after its SHA-256 matches its pin and every Python name its
pickle refers to is in that checkpoint's allow list. Only then does PyTorch's safe loader
(`weights_only=True`) read it. This is the only place in the tool that loads a pickle.
"""

import pickletools
import zipfile
from pathlib import Path
from typing import Any, Callable

from fetch import open_verified

_STRING_OPS = {
    'STRING',
    'BINSTRING',
    'SHORT_BINSTRING',
    'UNICODE',
    'BINUNICODE',
    'SHORT_BINUNICODE',
    'BINUNICODE8',
}
_PUT_OPS = {'PUT', 'BINPUT', 'LONG_BINPUT'}
_GET_OPS = {'GET', 'BINGET', 'LONG_BINGET'}
_EXT_OPS = {'EXT1', 'EXT2', 'EXT4'}
# Opcodes that neither push nor pop.
_NEUTRAL_OPS = {'PROTO', 'FRAME'}


class UnsafeCheckpoint(Exception):
    """A checkpoint refers to Python names outside its allow list, or cannot be checked."""

    def __init__(self, message: str, names: frozenset[str] = frozenset()) -> None:
        super().__init__(message)
        self.names = names


class _Unknown:
    """A stack value the scan cannot resolve to a string."""


_UNKNOWN = _Unknown()


def pickle_globals(data: bytes) -> set[str]:
    """Returns every `module.name` the pickle imports, as GLOBAL, INST or STACK_GLOBAL.

    Raises UnsafeCheckpoint when a STACK_GLOBAL's operands are not plain strings, or for
    the extension registry opcodes, whose names cannot be known from the pickle alone.
    """
    names: set[str] = set()
    memo: dict[int, Any] = {}
    # The values pushed so far, as far as STACK_GLOBAL needs them: a string or _UNKNOWN.
    pushed: list[Any] = []
    for opcode, arg, _pos in pickletools.genops(data):
        name = opcode.name
        if name in _NEUTRAL_OPS:
            continue
        if name in _PUT_OPS:
            memo[arg] = pushed[-1] if pushed else _UNKNOWN
        elif name == 'MEMOIZE':
            memo[len(memo)] = pushed[-1] if pushed else _UNKNOWN
        elif name in _GET_OPS:
            pushed.append(memo.get(arg, _UNKNOWN))
        elif name in _STRING_OPS:
            pushed.append(arg.decode('latin-1') if isinstance(arg, bytes) else arg)
        elif name in ('GLOBAL', 'INST'):
            module, _, attr = arg.partition(' ')
            names.add(f'{module}.{attr}')
            pushed.append(_UNKNOWN)
        elif name == 'STACK_GLOBAL':
            if len(pushed) < 2 or not all(isinstance(value, str) for value in pushed[-2:]):
                raise UnsafeCheckpoint('A STACK_GLOBAL in the pickle names a value the scan cannot read.')
            module, attr = pushed[-2], pushed[-1]
            names.add(f'{module}.{attr}')
            pushed.append(_UNKNOWN)
        elif name in _EXT_OPS:
            raise UnsafeCheckpoint(f'The pickle uses {name}, which names a class the scan cannot read.')
        else:
            pushed.append(_UNKNOWN)
    return names


def checkpoint_globals(path: Path) -> set[str]:
    """Returns the Python names that a PyTorch zip checkpoint's pickle refers to."""
    if not zipfile.is_zipfile(path):
        raise UnsafeCheckpoint(f'{path} is not a zip checkpoint. Legacy checkpoints are refused.')
    with zipfile.ZipFile(path) as archive:
        pickles = [entry for entry in archive.namelist() if entry.endswith('/data.pkl')]
        if len(pickles) != 1:
            raise UnsafeCheckpoint(f'{path} has {len(pickles)} data.pkl entries, not one.')
        return pickle_globals(archive.read(pickles[0]))


def load_checkpoint(
    path: Path,
    sha256: str,
    allowed: frozenset[str],
    extra_safe: Callable[[], list] = list,
) -> Any:
    """Loads a pinned checkpoint with PyTorch's safe loader, after the hash and name checks.

    `extra_safe` returns the classes outside PyTorch that the safe loader must accept. It is
    called only after both checks pass, so it may import the packages that define them.
    """

    def opener(verified: Path) -> Any:
        unknown = frozenset(checkpoint_globals(verified) - allowed)
        if unknown:
            raise UnsafeCheckpoint(
                f'{verified} refers to names outside its allow list: {", ".join(sorted(unknown))}',
                unknown,
            )
        import torch

        with torch.serialization.safe_globals(extra_safe()):
            return torch.load(verified, map_location='cpu', weights_only=True)

    return open_verified(path, sha256, opener)
