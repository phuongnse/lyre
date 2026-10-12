# Notice for wiktionary_words.txt

`wiktionary_words.txt` is licensed under the
[Creative Commons Attribution-ShareAlike 4.0 International licence (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
The MIT licence of the code in this repository does not cover it.

## Source

- **Authors:** the contributors to [English Wiktionary](https://en.wiktionary.org/).
- **Extraction:** by [Wiktextract](https://github.com/tatuylonen/wiktextract),
  published on [kaikki.org](https://kaikki.org/dictionary/Vietnamese/).
- **Dump:** `https://kaikki.org/dictionary/Vietnamese/kaikki.org-dictionary-Vietnamese.jsonl`,
  extracted on 2026-10-03 from the English Wiktionary dump of 2026-09-02.
- **Dump SHA-256:** `ba64fae8301bf3f383a82bb178f2370309d31b3bcb3a92e9b0c9e04aeb6ecc16`

## Changes made

- Only the Vietnamese headwords of two or more syllables are kept, where each
  syllable is made of Latin-script letters only. Proverbs are left out.
- The words are lowercased and put in Unicode NFC.
- Words that differ only in case or tone placement ("hoà" and "hòa") are kept
  once.
- The words are sorted, one per line. All other dictionary content is left out.

## Regenerating

Download the dump to `artifacts/`, then run
`node scripts/wiktionary-words.mjs artifacts/kaikki.org-dictionary-Vietnamese.jsonl`
from the repository root. The script refuses a dump whose SHA-256 does not
match the pinned hash. kaikki.org replaces its file in place, so a newer dump
needs a new date and hash in the script and in this notice. See
[D18](../../../../docs/decisions.md#d18-vietnamese-word-boundaries-from-a-word-list--agreed).
