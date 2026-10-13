//! The input and output rules and the vocabularies of each aligner, as
//! `docs/reference/models.md` sets them (D20). Omnilingual and
//! lyric-alignment then take the same path: Lyre prepares each window with
//! `AlignerKind::input`, runs the model, and turns its output into
//! log-probabilities with `AlignerKind::log_probs`.

use std::collections::HashMap;
use std::fmt;

use crate::alignment::{MAX_TOKEN_BYTES, MAX_VOCABULARY};

/// The largest vocabulary file accepted, in bytes.
pub const MAX_VOCABULARY_FILE_BYTES: usize = 1 << 20;
/// Added to the variance before its square root, as sherpa-onnx does.
const NORMALISATION_EPSILON: f64 = 1e-5;
/// The CTC blank of Omnilingual, at index 0 of `tokens.txt`.
const OMNILINGUAL_BLANK: &str = "<s>";
/// The CTC blank of lyric-alignment, an entry of `vocab.json`.
const LYRIC_ALIGNMENT_BLANK: &str = "<pad>";
/// The tokens lyric-alignment adds after the entries of `vocab.json`.
const LYRIC_ALIGNMENT_ADDED: [&str; 2] = ["<s>", "</s>"];

/// A candidate aligner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignerKind {
    /// Omnilingual CTC-300M, int8, from sherpa-onnx.
    Omnilingual,
    /// `lyric-alignment`, fp32 or int8.
    LyricAlignment,
}

impl AlignerKind {
    /// The name of the model's input.
    pub fn input_name(self) -> &'static str {
        match self {
            AlignerKind::Omnilingual => "x",
            AlignerKind::LyricAlignment => "input_values",
        }
    }

    /// The name of the model's output.
    pub fn output_name(self) -> &'static str {
        match self {
            AlignerKind::Omnilingual => "logits",
            AlignerKind::LyricAlignment => "log_probs",
        }
    }

    /// Whether Lyre normalises each window before the model, because the
    /// model file does not.
    pub fn normalises_input(self) -> bool {
        match self {
            AlignerKind::Omnilingual => true,
            AlignerKind::LyricAlignment => false,
        }
    }

    /// Whether Lyre applies log-softmax to each output frame, because the
    /// model file does not.
    pub fn applies_log_softmax(self) -> bool {
        match self {
            AlignerKind::Omnilingual => true,
            AlignerKind::LyricAlignment => false,
        }
    }

    /// The model's input for one window of 16 kHz mono samples.
    pub fn input(self, window: &[f32]) -> Vec<f32> {
        if self.normalises_input() {
            normalise(window)
        } else {
            window.to_vec()
        }
    }

    /// The natural-log probabilities from the model's output: frames of
    /// `width` values, one per vocabulary entry, frame by frame.
    pub fn log_probs(self, output: &[f32], width: usize) -> Result<Vec<f32>, OutputError> {
        if self.applies_log_softmax() {
            log_softmax(output, width)
        } else {
            check_frames(output, width)?;
            Ok(output.to_vec())
        }
    }

    /// Reads the model's vocabulary file: `tokens.txt` for Omnilingual and
    /// `vocab.json` for lyric-alignment.
    pub fn read_vocabulary(self, bytes: &[u8]) -> Result<Vocabulary, VocabularyError> {
        match self {
            AlignerKind::Omnilingual => read_tokens_txt(bytes),
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

/// Brings `samples` to zero mean and unit variance:
/// (x − mean) / √(variance + 1e-5). The variance divides by the number of
/// samples. The sums are done in f64.
pub fn normalise(samples: &[f32]) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let n = samples.len() as f64;
    let mean = samples.iter().map(|&x| f64::from(x)).sum::<f64>() / n;
    let variance = samples
        .iter()
        .map(|&x| (f64::from(x) - mean).powi(2))
        .sum::<f64>()
        / n;
    let scale = (variance + NORMALISATION_EPSILON).sqrt();
    samples
        .iter()
        .map(|&x| ((f64::from(x) - mean) / scale) as f32)
        .collect()
}

/// Applies log-softmax to each frame of `width` values in `values`. The
/// sums are done in f64.
pub fn log_softmax(values: &[f32], width: usize) -> Result<Vec<f32>, OutputError> {
    check_frames(values, width)?;
    let mut out = Vec::with_capacity(values.len());
    for frame in values.chunks_exact(width) {
        let max = frame
            .iter()
            .map(|&v| f64::from(v))
            .fold(f64::NEG_INFINITY, f64::max);
        let sum = frame
            .iter()
            .map(|&v| (f64::from(v) - max).exp())
            .sum::<f64>();
        let log_sum_exp = max + sum.ln();
        out.extend(frame.iter().map(|&v| (f64::from(v) - log_sum_exp) as f32));
    }
    Ok(out)
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
    /// The file breaks its format: at `line` of `tokens.txt`, or anywhere in
    /// `vocab.json`, which has no line.
    Malformed { line: Option<usize> },
    /// The vocabulary would have more than `limit` entries, counting the
    /// tokens Lyre adds.
    TooManyEntries { len: usize, limit: usize },
    /// Entry `index`, in the file's order for `tokens.txt` and in index
    /// order for `vocab.json`, is longer than `limit` bytes.
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
            VocabularyError::Malformed { line: Some(line) } => {
                write!(f, "line {} of the vocabulary file is malformed", line + 1)
            }
            VocabularyError::Malformed { line: None } => {
                write!(f, "the vocabulary file is malformed")
            }
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

/// Reads Omnilingual's `tokens.txt`: one token and its index per line,
/// split at the line's last space. Lines end with `\n`, and the last one
/// may have none. The blank, `<s>`, is at index 0.
fn read_tokens_txt(bytes: &[u8]) -> Result<Vocabulary, VocabularyError> {
    check_file_size(bytes)?;
    let text = std::str::from_utf8(bytes).map_err(|_| VocabularyError::NotUtf8)?;
    let mut entries = Vec::new();
    if !text.is_empty() {
        let body = text.strip_suffix('\n').unwrap_or(text);
        for (line, content) in body.split('\n').enumerate() {
            entries.push(
                parse_token_line(content).ok_or(VocabularyError::Malformed { line: Some(line) })?,
            );
        }
    }
    if entries.len() > MAX_VOCABULARY {
        return Err(VocabularyError::TooManyEntries {
            len: entries.len(),
            limit: MAX_VOCABULARY,
        });
    }
    check_token_lengths(entries.iter().map(|&(token, _)| token))?;
    let mut tokens = vec![None; entries.len()];
    for (token, index) in entries {
        match tokens.get_mut(index) {
            Some(slot @ None) => *slot = Some(token.to_owned()),
            _ => return Err(VocabularyError::Indexes),
        }
    }
    // Every slot is filled: n entries took n different indexes below n.
    let tokens: Vec<String> = tokens.into_iter().flatten().collect();
    if tokens.first().map(String::as_str) != Some(OMNILINGUAL_BLANK) {
        return Err(VocabularyError::MissingBlank);
    }
    Ok(Vocabulary { tokens, blank: 0 })
}

/// One `tokens.txt` line as its token and index, or None when it breaks
/// the format.
fn parse_token_line(line: &str) -> Option<(&str, usize)> {
    if line.contains('\r') {
        return None;
    }
    let (token, index) = line.rsplit_once(' ')?;
    if token.is_empty() || index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((token, index.parse().ok()?))
}

/// Reads lyric-alignment's `vocab.json`: a JSON object from each token to
/// its index. `<s>` and `</s>` follow its entries. The blank is `<pad>`.
fn read_vocab_json(bytes: &[u8]) -> Result<Vocabulary, VocabularyError> {
    check_file_size(bytes)?;
    std::str::from_utf8(bytes).map_err(|_| VocabularyError::NotUtf8)?;
    // The parser's message is dropped, because it may quote a token.
    let map: HashMap<String, u32> =
        serde_json::from_slice(bytes).map_err(|_| VocabularyError::Malformed { line: None })?;
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

    const OMNI: AlignerKind = AlignerKind::Omnilingual;
    const LYRIC: AlignerKind = AlignerKind::LyricAlignment;

    fn assert_close(actual: &[f32], expected: &[f32], tolerance: f32) {
        assert_eq!(actual.len(), expected.len());
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() <= tolerance, "{actual:?} is not {expected:?}");
        }
    }

    fn strings(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|&t| t.to_owned()).collect()
    }

    /// A `tokens.txt` of `n` lines with `<s>` at index 0.
    fn tokens_txt(n: usize) -> String {
        (0..n)
            .map(|i| {
                if i == 0 {
                    "<s> 0\n".to_owned()
                } else {
                    format!("t{i} {i}\n")
                }
            })
            .collect()
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
    fn each_kind_names_its_input_and_output() {
        assert_eq!(OMNI.input_name(), "x");
        assert_eq!(OMNI.output_name(), "logits");
        assert!(OMNI.normalises_input());
        assert!(OMNI.applies_log_softmax());
        assert_eq!(LYRIC.input_name(), "input_values");
        assert_eq!(LYRIC.output_name(), "log_probs");
        assert!(!LYRIC.normalises_input());
        assert!(!LYRIC.applies_log_softmax());
    }

    #[test]
    fn omnilingual_normalises_to_zero_mean_and_unit_variance() {
        let expected = [-1.341_635_4, -0.447_211_7, 0.447_211_7, 1.341_635_4];
        assert_close(&normalise(&[1.0, 2.0, 3.0, 4.0]), &expected, 1e-6);
        assert_close(&OMNI.input(&[1.0, 2.0, 3.0, 4.0]), &expected, 1e-6);
    }

    #[test]
    fn normalising_a_constant_or_empty_window_gives_zeros() {
        assert_eq!(normalise(&[0.25; 5]), vec![0.0; 5]);
        assert_eq!(normalise(&[]), Vec::<f32>::new());
    }

    #[test]
    fn lyric_alignment_passes_samples_unchanged() {
        let window = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(LYRIC.input(&window), window.to_vec());
    }

    #[test]
    fn omnilingual_applies_log_softmax_to_each_frame() {
        let output = [1.0, 2.0, 3.0, 1001.0, 1002.0, 1003.0];
        let frame = [-2.407_606, -1.407_606, -0.407_606];
        let expected: Vec<f32> = frame.iter().chain(&frame).copied().collect();
        assert_close(&log_softmax(&output, 3).expect("valid"), &expected, 1e-5);
        assert_close(&OMNI.log_probs(&output, 3).expect("valid"), &expected, 1e-5);
    }

    #[test]
    fn lyric_alignment_passes_log_probs_unchanged() {
        let output = [-0.5, -1.5, -2.5, -3.5];
        assert_eq!(LYRIC.log_probs(&output, 2), Ok(output.to_vec()));
    }

    #[test]
    fn an_output_that_is_not_whole_frames_is_refused() {
        for kind in [OMNI, LYRIC] {
            assert_eq!(
                kind.log_probs(&[0.0; 4], 3),
                Err(OutputError { len: 4, width: 3 })
            );
            assert_eq!(
                kind.log_probs(&[0.0; 4], 0),
                Err(OutputError { len: 4, width: 0 })
            );
            let over = MAX_VOCABULARY + 1;
            assert_eq!(
                kind.log_probs(&vec![0.0; over], over),
                Err(OutputError {
                    len: over,
                    width: over
                })
            );
            assert!(kind.log_probs(&[], 3).expect("valid").is_empty());
        }
    }

    #[test]
    fn omnilingual_reads_tokens_txt() {
        let vocabulary = OMNI
            .read_vocabulary(b"<s> 0\n<pad> 1\n  2\na 3\n")
            .expect("valid");
        assert_eq!(vocabulary.tokens, strings(&["<s>", "<pad>", " ", "a"]));
        assert_eq!(vocabulary.blank, 0);
    }

    #[test]
    fn tokens_txt_lines_may_come_in_any_order_and_the_last_newline_may_be_missing() {
        let vocabulary = OMNI.read_vocabulary(b"a 1\n<s> 0").expect("valid");
        assert_eq!(vocabulary.tokens, strings(&["<s>", "a"]));
        assert_eq!(vocabulary.blank, 0);
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
        for kind in [OMNI, LYRIC] {
            assert_eq!(
                kind.read_vocabulary(&over),
                Err(VocabularyError::FileTooLarge {
                    len: MAX_VOCABULARY_FILE_BYTES + 1,
                    limit: MAX_VOCABULARY_FILE_BYTES
                })
            );
        }
    }

    #[test]
    fn a_vocabulary_with_too_many_entries_is_refused() {
        assert!(
            OMNI.read_vocabulary(tokens_txt(MAX_VOCABULARY).as_bytes())
                .is_ok()
        );
        assert_eq!(
            OMNI.read_vocabulary(tokens_txt(MAX_VOCABULARY + 1).as_bytes()),
            Err(VocabularyError::TooManyEntries {
                len: MAX_VOCABULARY + 1,
                limit: MAX_VOCABULARY
            })
        );
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
            OMNI.read_vocabulary(b"<pad> 0\n<s> 1\n"),
            Err(VocabularyError::MissingBlank)
        );
        assert_eq!(
            OMNI.read_vocabulary(b""),
            Err(VocabularyError::MissingBlank)
        );
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
        let error = Err(VocabularyError::TokenTooLong {
            index: 1,
            len: MAX_TOKEN_BYTES + 1,
            limit: MAX_TOKEN_BYTES,
        });
        assert!(
            OMNI.read_vocabulary(format!("<s> 0\n{at_limit} 1\n").as_bytes())
                .is_ok()
        );
        assert_eq!(
            OMNI.read_vocabulary(format!("<s> 0\n{over} 1\n").as_bytes()),
            error
        );
        assert!(
            LYRIC
                .read_vocabulary(format!(r#"{{"<pad>": 0, "{at_limit}": 1}}"#).as_bytes())
                .is_ok()
        );
        assert_eq!(
            LYRIC.read_vocabulary(format!(r#"{{"<pad>": 0, "{over}": 1}}"#).as_bytes()),
            error
        );
    }

    #[test]
    fn indexes_must_be_0_to_n_minus_1_each_used_once() {
        for file in [&b"<s> 0\na 0\n"[..], b"<s> 0\na 2\n", b"<s> 1\na 2\n"] {
            assert_eq!(OMNI.read_vocabulary(file), Err(VocabularyError::Indexes));
        }
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
    fn a_tokens_txt_line_that_breaks_the_format_is_refused() {
        for (file, line) in [
            (&b"<s> 0\r\na 1\r\n"[..], 0),
            (b"<s> 0\n 1\n", 1),
            (b"<s> 0\na\n", 1),
            (b"<s> 0\na \n", 1),
            (b"<s> 0\na +1\n", 1),
            (b"<s> 0\na 1x\n", 1),
            (b"<s> 0\na 99999999999999999999999\n", 1),
            (b"<s> 0\n\na 1\n", 1),
            (b"<s> 0\na 1\n\n", 2),
            (b"\n", 0),
        ] {
            assert_eq!(
                OMNI.read_vocabulary(file),
                Err(VocabularyError::Malformed { line: Some(line) }),
                "{file:?}"
            );
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
                Err(VocabularyError::Malformed { line: None }),
                "{file:?}"
            );
        }
    }

    #[test]
    fn a_vocabulary_file_that_is_not_utf8_is_refused() {
        for kind in [OMNI, LYRIC] {
            assert_eq!(
                kind.read_vocabulary(b"<s> 0\n\xff 1\n"),
                Err(VocabularyError::NotUtf8)
            );
        }
    }

    #[test]
    fn no_message_quotes_a_token() {
        let secret = "secret-token-text";
        let errors = [
            OMNI.read_vocabulary(format!("<s> 0\n{secret} 2\n").as_bytes()),
            OMNI.read_vocabulary(format!("{secret} 0\n").as_bytes()),
            OMNI.read_vocabulary(format!("<s> 0\n{} 1\n", secret.repeat(5)).as_bytes()),
            OMNI.read_vocabulary(format!("<s> 0\n{secret}\n").as_bytes()),
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
}
