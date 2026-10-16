//! The 24 words of a recovery seed.
//!
//! The text is in `docs/reference/device-access.md#words-and-qr-content`: the
//! seed's 256 bits and the first byte of its SHA-256, read as 24 groups of 11
//! bits that index the BIP39 English list. Every intermediate buffer that
//! holds the seed or its words is wiped when it drops. No error holds a word.

use std::fmt;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::SEED_LEN;

/// The BIP39 English word list, one word per line in alphabetical order.
/// `bip39-english.NOTICE.md` has its source and licence.
const LIST: &str = include_str!("bip39-english.txt");

/// The number of words of a recovery key.
const WORD_COUNT: usize = 24;

/// The size of a word index, in bits.
const INDEX_BITS: usize = 11;

/// The size of the seed and its checksum byte, in bytes.
const CHECKED_LEN: usize = SEED_LEN + 1;

/// The length of the longest word of the list.
const MAX_WORD_LEN: usize = 8;

/// Why recovery words were refused. The reason never repeats the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryWordsError {
    /// There are not exactly 24 words. Found before any word is looked up.
    Count,
    /// A word is not in the list, or is only the start of one.
    Word,
    /// The eight checksum bits do not match the seed.
    Checksum,
    /// The seed gives no key pair, because its derived scalar is zero. No
    /// real seed is known to do this.
    ZeroScalar,
}

impl fmt::Display for RecoveryWordsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            RecoveryWordsError::Count => "the recovery key does not have 24 words",
            RecoveryWordsError::Word => "the recovery key has a word that is not in the list",
            RecoveryWordsError::Checksum => "the recovery key has a bad checksum",
            RecoveryWordsError::ZeroScalar => "the recovery key gives no valid key pair",
        };
        write!(f, "{reason}")
    }
}

impl std::error::Error for RecoveryWordsError {}

/// The word at `index`, which is below 2,048.
fn word(index: usize) -> &'static str {
    LIST.lines().nth(index).expect("the list has 2,048 words")
}

/// The index of a word of the list, or none. Case is already folded.
fn index_of(word: &str) -> Option<usize> {
    LIST.lines().position(|listed| listed == word)
}

/// The 24 lowercase words of `seed`, separated by single spaces.
pub(crate) fn words_from_seed(seed: &[u8; SEED_LEN]) -> Zeroizing<String> {
    let mut checked = Zeroizing::new([0u8; CHECKED_LEN]);
    checked[..SEED_LEN].copy_from_slice(seed);
    checked[SEED_LEN] = Sha256::digest(seed)[0];
    let mut text = Zeroizing::new(String::with_capacity(WORD_COUNT * (MAX_WORD_LEN + 1)));
    for position in 0..WORD_COUNT {
        let mut index = 0usize;
        for bit in position * INDEX_BITS..(position + 1) * INDEX_BITS {
            index = (index << 1) | usize::from(checked[bit / 8] >> (7 - bit % 8) & 1);
        }
        if position > 0 {
            text.push(' ');
        }
        text.push_str(word(index));
    }
    text
}

/// Reads recovery words: lowercase or uppercase ASCII, with any ASCII
/// whitespace between them.
pub(crate) fn seed_from_words(text: &str) -> Result<Zeroizing<[u8; SEED_LEN]>, RecoveryWordsError> {
    if text.split_ascii_whitespace().take(WORD_COUNT + 1).count() != WORD_COUNT {
        return Err(RecoveryWordsError::Count);
    }
    let mut checked = Zeroizing::new([0u8; CHECKED_LEN]);
    for (position, word) in text.split_ascii_whitespace().enumerate() {
        let index = lookup(word).ok_or(RecoveryWordsError::Word)?;
        for offset in 0..INDEX_BITS {
            let bit = position * INDEX_BITS + offset;
            checked[bit / 8] |=
                u8::from(index >> (INDEX_BITS - 1 - offset) & 1 == 1) << (7 - bit % 8);
        }
    }
    let mut seed = Zeroizing::new([0u8; SEED_LEN]);
    seed.copy_from_slice(&checked[..SEED_LEN]);
    if checked[SEED_LEN] != Sha256::digest(seed.as_slice())[0] {
        return Err(RecoveryWordsError::Checksum);
    }
    Ok(seed)
}

/// The index of a typed word. The lowercase copy is a stack buffer that is
/// wiped before it returns.
fn lookup(word: &str) -> Option<usize> {
    if word.len() > MAX_WORD_LEN || !word.is_ascii() {
        return None;
    }
    let mut folded = Zeroizing::new([0u8; MAX_WORD_LEN]);
    folded[..word.len()].copy_from_slice(word.as_bytes());
    folded.make_ascii_lowercase();
    let folded = std::str::from_utf8(&folded[..word.len()]).ok()?;
    index_of(folded)
}

#[cfg(test)]
mod tests {
    use super::super::tests::DEVICE_DOC;
    use super::super::{hex, table, unhex};
    use super::*;

    /// The SHA-256 of the list, as pinned in `bip39-english.NOTICE.md`.
    const LIST_SHA256: &str = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

    /// The rows of the first table after the heading's paragraph.
    fn rows(start: &str) -> Vec<Vec<String>> {
        let (_, after) = DEVICE_DOC
            .split_once("### Recovery key\n\nEach row")
            .expect("the doc has the recovery key vectors");
        table(after, start)
    }

    fn word_rows() -> Vec<Vec<String>> {
        rows("Each row of this table gives a seed")
    }

    fn bad_rows() -> Vec<Vec<String>> {
        rows("Each row of this table gives words that the core refuses")
    }

    fn seed_of(row: &[String]) -> [u8; 32] {
        unhex(&row[0]).try_into().expect("32 bytes")
    }

    #[test]
    fn the_list_has_2048_sorted_words_and_the_pinned_hash() {
        let words: Vec<&str> = LIST.lines().collect();
        assert_eq!(words.len(), 2048);
        assert!(words.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            words.iter().all(|w| (3..=MAX_WORD_LEN).contains(&w.len())
                && w.bytes().all(|b| b.is_ascii_lowercase()))
        );
        assert!(LIST.ends_with('\n') && !LIST.contains('\r'));
        assert_eq!(hex(&Sha256::digest(LIST.as_bytes())), LIST_SHA256);
        assert!(include_str!("bip39-english.NOTICE.md").contains(LIST_SHA256));
        assert_eq!((words[0], words[2047]), ("abandon", "zoo"));
    }

    #[test]
    fn a_seed_gives_the_documented_words_and_back() {
        assert_eq!(word_rows().len(), 3);
        for row in word_rows() {
            let seed = seed_of(&row);
            assert_eq!(words_from_seed(&seed).as_str(), row[1], "{}", row[0]);
            assert_eq!(*seed_from_words(&row[1]).expect("valid words"), seed);
        }
    }

    #[test]
    fn the_words_give_the_documented_key_pair() {
        for row in word_rows() {
            let key_row = super::super::tests::key_rows()
                .into_iter()
                .find(|key_row| key_row[0] == row[0])
                .expect("the seed has a key pair row");
            let key = super::super::RecoveryKey::from_words(&row[1]).expect("valid words");
            assert_eq!(hex(&key.public_key().to_compressed()), key_row[2]);
        }
    }

    #[test]
    fn each_bad_row_gives_its_reason() {
        let rows = bad_rows();
        assert_eq!(rows.len(), 8);
        for row in rows {
            let expected = match row[2].as_str() {
                "Count" => RecoveryWordsError::Count,
                "Word" => RecoveryWordsError::Word,
                "Checksum" => RecoveryWordsError::Checksum,
                other => panic!("unknown reason {other}"),
            };
            assert_eq!(seed_from_words(&row[1]).err(), Some(expected), "{}", row[0]);
        }
    }

    #[test]
    fn no_words_and_blank_words_are_a_count_error() {
        for text in ["", " ", "\n\t "] {
            assert_eq!(seed_from_words(text).err(), Some(RecoveryWordsError::Count));
        }
    }

    #[test]
    fn uppercase_and_extra_whitespace_read_to_the_same_seed() {
        let row = &word_rows()[1];
        let seed = seed_of(row);
        assert_eq!(
            *seed_from_words(&row[1].to_uppercase()).expect("uppercase"),
            seed
        );
        let mixed: String = row[1]
            .split(' ')
            .enumerate()
            .map(|(i, w)| {
                if i % 2 == 0 {
                    w.to_uppercase()
                } else {
                    w.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\t\n \r");
        let spaced = format!("  {mixed}\n");
        assert_eq!(*seed_from_words(&spaced).expect("spaced"), seed);
    }

    #[test]
    fn a_word_with_other_characters_is_refused() {
        let words = &word_rows()[0][1];
        for first in [
            "Abandón",
            "abandon1",
            "abandon-",
            "abandonabandon",
            "ａｂａｎｄｏｎ",
        ] {
            let text = words.replacen("abandon", first, 1);
            assert_eq!(
                seed_from_words(&text).err(),
                Some(RecoveryWordsError::Word),
                "{first}"
            );
        }
    }

    #[test]
    fn error_text_holds_no_word() {
        for row in bad_rows() {
            let error = seed_from_words(&row[1]).expect_err("refused");
            let text = format!("{error:?} {error}");
            for typed in row[1].split(' ') {
                assert!(!text.split(' ').any(|part| part == typed), "{text}");
            }
        }
    }
}
