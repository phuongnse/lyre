# Notice for bip39-english.txt

`bip39-english.txt` is the BIP39 English word list. It is a list of 2,048
common English words, one per line, in alphabetical order. The core uses it to
write and read the 24 words of the recovery key.

The list comes with a copy that carries the MIT licence, the same licence as
the code in this repository. The text of [BIP39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
itself states no clear licence for the list, so this file is taken from the
copy that does.

## Source

- **Licensed copy:** `https://raw.githubusercontent.com/trezor/python-mnemonic/master/src/mnemonic/wordlist/english.txt`
  in [python-mnemonic](https://github.com/trezor/python-mnemonic) by Pavol Rusnak,
  under the MIT licence.
- **Same bytes:** `https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt`
  in [bitcoin/bips](https://github.com/bitcoin/bips). The two files were
  compared with `cmp` on 2026-10-16 and are identical.
- **SHA-256:** `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`

## Licence of the licensed copy

```text
The MIT License (MIT)

Copyright (c) 2013-2016 Pavol Rusnak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Changes made

None. The file is used byte for byte. A test in the core checks its SHA-256.
The list must never change: a different word at any position would give other
words for the same recovery seed. See
[the recovery key](../../../../docs/reference/device-access.md#words-and-qr-content).
