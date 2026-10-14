//! The output rule and the vocabulary of the aligner, as
//! `docs/reference/models.md` sets them (D20, D29). Lyre passes each window's
//! samples to the model, and checks its output with `AlignerKind::log_probs`.

use std::collections::HashMap;
use std::fmt;

use crate::alignment::{MAX_TOKEN_BYTES, MAX_VOCABULARY};

/// The largest vocabulary file accepted, in bytes.
pub const MAX_VOCABULARY_FILE_BYTES: usize = 1 << 20;
/// The CTC blank of lyric-alignment, an entry of `vocab.json`.
const LYRIC_ALIGNMENT_BLANK: &str = "<pad>";
/// The tokens lyric-alignment adds after the entries of `vocab.json`.
const LYRIC_ALIGNMENT_ADDED: [&str; 2] = ["<s>", "</s>"];

/// A candidate aligner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignerKind {
    /// `lyric-alignment`, fp32 or int8.
    LyricAlignment,
}

impl AlignerKind {
    /// The name of the model's input.
    pub fn input_name(self) -> &'static str {
        match self {
            AlignerKind::LyricAlignment => "input_values",
        }
    }

    /// The name of the model's output.
    pub fn output_name(self) -> &'static str {
        match self {
            AlignerKind::LyricAlignment => "log_probs",
        }
    }

    /// The natural-log probabilities from the model's output: frames of
    /// `width` values, one per vocabulary entry, frame by frame.
    pub fn log_probs(self, output: &[f32], width: usize) -> Result<Vec<f32>, OutputError> {
        check_frames(output, width)?;
        Ok(output.to_vec())
    }

    /// Reads the model's vocabulary file, `vocab.json`.
    pub fn read_vocabulary(self, bytes: &[u8]) -> Result<Vocabulary, VocabularyError> {
        match self {
            AlignerKind::LyricAlignment => read_vocab_json(bytes),
        }
    }
}

/// A model's vocabulary, ready for `alignment::Emissions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vocabulary {
    /// The model's tokens, by index.
    pub tokens: Vec<String>,
    /// The index of the blank token.
    pub blank: usize,
}

/// Checks that `values` is whole frames of `width` values, with `width`
/// from 1 to `MAX_VOCABULARY`.
fn check_frames(values: &[f32], width: usize) -> Result<(), OutputError> {
    if width == 0 || width > MAX_VOCABULARY || !values.len().is_multiple_of(width) {
        return Err(OutputError {
            len: values.len(),
            width,
        });
    }
    Ok(())
}

/// Why a model's output was refused: its `len` values are not whole frames
/// of `width`, or `width` is not from 1 to `MAX_VOCABULARY`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputError {
    pub len: usize,
    pub width: usize,
}

impl fmt::Display for OutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} output values are not whole frames of {}, with frames of 1 to {} values",
            self.len, self.width, MAX_VOCABULARY
        )
    }
}

impl std::error::Error for OutputError {}

/// Why a vocabulary file was refused. Fields count from 0. No message quotes
/// the token text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VocabularyError {
    /// The file is longer than `limit` bytes.
    FileTooLarge { len: usize, limit: usize },
    /// The file is not UTF-8.
    NotUtf8,
    /// The file breaks its format.
    Malformed,
    /// The vocabulary would have more than `limit` entries, counting the
    /// tokens Lyre adds.
    TooManyEntries { len: usize, limit: usize },
    /// Entry `index`, in index order, is longer than `limit` bytes.
    TokenTooLong {
        index: usize,
        len: usize,
        limit: usize,
    },
    /// The indexes are not 0 to n − 1, each used once.
    Indexes,
    /// The blank token is not where the aligner keeps it.
    MissingBlank,
}

impl fmt::Display for VocabularyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VocabularyError::FileTooLarge { len, limit } => write!(
                f,
                "the vocabulary file is {len} bytes, over the limit of {limit} bytes"
            ),
            VocabularyError::NotUtf8 => write!(f, "the vocabulary file is not UTF-8"),
            VocabularyError::Malformed => write!(f, "the vocabulary file is malformed"),
            VocabularyError::TooManyEntries { len, limit } => write!(
                f,
                "the vocabulary has {len} entries, over the limit of {limit}"
            ),
            VocabularyError::TokenTooLong { index, len, limit } => write!(
                f,
                "vocabulary entry {} is {len} bytes, over the limit of {limit} bytes",
                index + 1
            ),
            VocabularyError::Indexes => write!(
                f,
                "the vocabulary indexes are not 0 to one less than the entry count, each used once"
            ),
            VocabularyError::MissingBlank => write!(f, "the vocabulary has no blank token"),
        }
    }
}

impl std::error::Error for VocabularyError {}

/// Refuses a vocabulary file longer than `MAX_VOCABULARY_FILE_BYTES`.
fn check_file_size(bytes: &[u8]) -> Result<(), VocabularyError> {
    if bytes.len() > MAX_VOCABULARY_FILE_BYTES {
        return Err(VocabularyError::FileTooLarge {
            len: bytes.len(),
            limit: MAX_VOCABULARY_FILE_BYTES,
        });
    }
    Ok(())
}

/// Refuses the first token longer than `MAX_TOKEN_BYTES`.
fn check_token_lengths<'a>(tokens: impl Iterator<Item = &'a str>) -> Result<(), VocabularyError> {
    for (index, token) in tokens.enumerate() {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(VocabularyError::TokenTooLong {
                index,
                len: token.len(),
                limit: MAX_TOKEN_BYTES,
            });
        }
    }
    Ok(())
}

/// Reads lyric-alignment's `vocab.json`: a JSON object from each token to
/// its index. `<s>` and `</s>` follow its entries. The blank is `<pad>`.
fn read_vocab_json(bytes: &[u8]) -> Result<Vocabulary, VocabularyError> {
    check_file_size(bytes)?;
    std::str::from_utf8(bytes).map_err(|_| VocabularyError::NotUtf8)?;
    // The parser's message is dropped, because it may quote a token.
    let map: HashMap<String, u32> =
        serde_json::from_slice(bytes).map_err(|_| VocabularyError::Malformed)?;
    let len = map.len() + LYRIC_ALIGNMENT_ADDED.len();
    if len > MAX_VOCABULARY {
        return Err(VocabularyError::TooManyEntries {
            len,
            limit: MAX_VOCABULARY,
        });
    }
    let mut entries: Vec<(u32, String)> = map.into_iter().map(|(t, i)| (i, t)).collect();
    entries.sort_unstable();
    check_token_lengths(entries.iter().map(|(_, token)| token.as_str()))?;
    // A duplicate key collapses in the map, which leaves a gap here.
    if entries
        .iter()
        .enumerate()
        .any(|(position, &(index, _))| usize::try_from(index) != Ok(position))
    {
        return Err(VocabularyError::Indexes);
    }
    let mut tokens: Vec<String> = entries.into_iter().map(|(_, token)| token).collect();
    let blank = tokens
        .iter()
        .position(|token| token == LYRIC_ALIGNMENT_BLANK)
        .ok_or(VocabularyError::MissingBlank)?;
    tokens.extend(LYRIC_ALIGNMENT_ADDED.iter().map(|&token| token.to_owned()));
    Ok(Vocabulary { tokens, blank })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LYRIC: AlignerKind = AlignerKind::LyricAlignment;

    fn strings(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|&t| t.to_owned()).collect()
    }

    /// A `vocab.json` of `n` entries with `<pad>` at index 0.
    fn vocab_json(n: usize) -> String {
        let entries: Vec<String> = (0..n)
            .map(|i| {
                if i == 0 {
                    "\"<pad>\": 0".to_owned()
                } else {
                    format!("\"t{i}\": {i}")
                }
            })
            .collect();
        format!("{{{}}}", entries.join(", "))
    }

    #[test]
    fn the_kind_names_its_input_and_output() {
        assert_eq!(LYRIC.input_name(), "input_values");
        assert_eq!(LYRIC.output_name(), "log_probs");
    }

    #[test]
    fn lyric_alignment_passes_log_probs_unchanged() {
        let output = [-0.5, -1.5, -2.5, -3.5];
        assert_eq!(LYRIC.log_probs(&output, 2), Ok(output.to_vec()));
    }

    #[test]
    fn an_output_that_is_not_whole_frames_is_refused() {
        assert_eq!(
            LYRIC.log_probs(&[0.0; 4], 3),
            Err(OutputError { len: 4, width: 3 })
        );
        assert_eq!(
            LYRIC.log_probs(&[0.0; 4], 0),
            Err(OutputError { len: 4, width: 0 })
        );
        let over = MAX_VOCABULARY + 1;
        assert_eq!(
            LYRIC.log_probs(&vec![0.0; over], over),
            Err(OutputError {
                len: over,
                width: over
            })
        );
        assert!(LYRIC.log_probs(&[], 3).expect("valid").is_empty());
    }

    #[test]
    fn lyric_alignment_reads_vocab_json_and_adds_its_tokens() {
        let vocabulary = LYRIC
            .read_vocabulary(br#"{"|": 0, "a": 1, "<pad>": 2}"#)
            .expect("valid");
        assert_eq!(
            vocabulary.tokens,
            strings(&["|", "a", "<pad>", "<s>", "</s>"])
        );
        assert_eq!(vocabulary.blank, 2);
    }

    #[test]
    fn vocab_json_reads_string_escapes() {
        let vocabulary = LYRIC
            .read_vocabulary(br#"{"<pad>": 0, "\u00e0": 1, "\ud83c\udfb5": 2}"#)
            .expect("valid");
        assert_eq!(
            vocabulary.tokens,
            strings(&["<pad>", "à", "🎵", "<s>", "</s>"])
        );
    }

    #[test]
    fn a_vocabulary_file_over_the_size_limit_is_refused() {
        let over = vec![b' '; MAX_VOCABULARY_FILE_BYTES + 1];
        assert_eq!(
            LYRIC.read_vocabulary(&over),
            Err(VocabularyError::FileTooLarge {
                len: MAX_VOCABULARY_FILE_BYTES + 1,
                limit: MAX_VOCABULARY_FILE_BYTES
            })
        );
    }

    #[test]
    fn a_vocabulary_with_too_many_entries_is_refused() {
        // lyric-alignment adds two tokens to the file's entries.
        assert!(
            LYRIC
                .read_vocabulary(vocab_json(MAX_VOCABULARY - 2).as_bytes())
                .is_ok()
        );
        assert_eq!(
            LYRIC.read_vocabulary(vocab_json(MAX_VOCABULARY - 1).as_bytes()),
            Err(VocabularyError::TooManyEntries {
                len: MAX_VOCABULARY + 1,
                limit: MAX_VOCABULARY
            })
        );
    }

    #[test]
    fn a_vocabulary_without_its_blank_is_refused() {
        assert_eq!(
            LYRIC.read_vocabulary(br#"{"|": 0, "a": 1}"#),
            Err(VocabularyError::MissingBlank)
        );
        assert_eq!(
            LYRIC.read_vocabulary(b"{}"),
            Err(VocabularyError::MissingBlank)
        );
    }

    #[test]
    fn a_token_over_the_length_limit_is_refused() {
        let at_limit = "x".repeat(MAX_TOKEN_BYTES);
        let over = "x".repeat(MAX_TOKEN_BYTES + 1);
        assert!(
            LYRIC
                .read_vocabulary(format!(r#"{{"<pad>": 0, "{at_limit}": 1}}"#).as_bytes())
                .is_ok()
        );
        assert_eq!(
            LYRIC.read_vocabulary(format!(r#"{{"<pad>": 0, "{over}": 1}}"#).as_bytes()),
            Err(VocabularyError::TokenTooLong {
                index: 1,
                len: MAX_TOKEN_BYTES + 1,
                limit: MAX_TOKEN_BYTES,
            })
        );
    }

    #[test]
    fn indexes_must_be_0_to_n_minus_1_each_used_once() {
        for file in [
            &br#"{"<pad>": 0, "a": 0}"#[..],
            br#"{"<pad>": 0, "a": 2}"#,
            br#"{"<pad>": 1, "a": 2}"#,
            // The duplicate key collapses, which leaves index 1 unused.
            br#"{"<pad>": 0, "a": 1, "a": 2}"#,
        ] {
            assert_eq!(LYRIC.read_vocabulary(file), Err(VocabularyError::Indexes));
        }
    }

    #[test]
    fn a_vocab_json_that_is_not_an_object_of_indexes_is_refused() {
        for file in [
            &b"[1]"[..],
            br#"{"a": 1.5}"#,
            br#"{"a": -1}"#,
            br#"{"a": "1"}"#,
            br#"{"a": 1"#,
            b"",
        ] {
            assert_eq!(
                LYRIC.read_vocabulary(file),
                Err(VocabularyError::Malformed),
                "{file:?}"
            );
        }
    }

    #[test]
    fn a_vocabulary_file_that_is_not_utf8_is_refused() {
        assert_eq!(
            LYRIC.read_vocabulary(b"{\"<pad>\": 0, \"\xff\": 1}"),
            Err(VocabularyError::NotUtf8)
        );
    }

    #[test]
    fn no_message_quotes_a_token() {
        let secret = "secret-token-text";
        let errors = [
            LYRIC.read_vocabulary(format!(r#"{{"{secret}": 0}}"#).as_bytes()),
            LYRIC.read_vocabulary(format!(r#"{{"{secret}": "x"}}"#).as_bytes()),
            LYRIC.read_vocabulary(format!(r#"{{"<pad>": 0, "{secret}": 3}}"#).as_bytes()),
            LYRIC.read_vocabulary(
                format!(r#"{{"<pad>": 0, "{}": 1}}"#, secret.repeat(5)).as_bytes(),
            ),
        ];
        for error in errors {
            let message = error.expect_err("refused").to_string();
            assert!(!message.contains(secret), "{message}");
        }
    }

    #[test]
    fn the_committed_test_vocabulary_covers_the_fixture_lyrics() {
        let lyrics =
            crate::lyrics::Lyrics::parse(include_bytes!("../../../tests/fixtures/song/lyrics.txt"))
                .expect("valid lyrics");
        let bytes = include_bytes!("../../../tests/fixtures/models/lyric-alignment-vocab.json");
        let vocabulary = LYRIC.read_vocabulary(bytes).expect("valid");
        assert_eq!(vocabulary.tokens.len(), 25);
        assert_eq!(vocabulary.blank, 22);
        assert_eq!(vocabulary.tokens[22], "<pad>");
        let log_probs = vec![-(25f32).ln(); 200 * 25];
        let emissions = crate::alignment::Emissions {
            log_probs: &log_probs,
            vocabulary: &vocabulary.tokens,
            blank: vocabulary.blank,
            frame_us: 20_000,
        };
        let aligned = crate::alignment::align(&lyrics, &emissions, 4_000);
        assert!(aligned.is_ok(), "{aligned:?}");
    }
}
