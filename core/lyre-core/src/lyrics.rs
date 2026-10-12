//! Lyrics: the owner's supplied text, kept exactly, split into lyric lines
//! and syllables.
//!
//! The rules are in `docs/domain/knowledge.md`, under "Lyrics". The parser
//! never changes, normalises or corrects the text (D5). Every lyric line and
//! syllable records its byte range in the bytes as supplied.

use std::fmt;
use std::ops::Range;

/// The largest accepted lyrics input, in bytes, counting a leading
/// byte-order mark.
pub const MAX_LYRICS_BYTES: usize = 1_048_576;

/// The UTF-8 byte-order mark. A leading one is kept in the bytes and skipped
/// when reading lines and syllables.
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Accepted lyrics: the exact supplied bytes and the lyric lines read from
/// them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lyrics {
    text: String,
    lines: Vec<LyricLine>,
}

impl Lyrics {
    /// Accepts or rejects `input`. The checks run in a fixed order: size,
    /// UTF-8, NUL, letters. A rejected input reports the first rule it
    /// breaks.
    pub fn parse(input: &[u8]) -> Result<Lyrics, LyricsError> {
        if input.len() > MAX_LYRICS_BYTES {
            return Err(LyricsError::TooLarge {
                len: input.len(),
                limit: MAX_LYRICS_BYTES,
            });
        }
        let text = std::str::from_utf8(input).map_err(|err| LyricsError::InvalidUtf8 {
            offset: err.valid_up_to(),
        })?;
        if let Some(offset) = input.iter().position(|&byte| byte == 0) {
            return Err(LyricsError::NulCharacter { offset });
        }
        let start = if input.starts_with(BOM) { BOM.len() } else { 0 };
        let lines = read_lines(text, start);
        let has_letters = lines
            .iter()
            .flat_map(|line| &line.syllables)
            .any(|syllable| {
                text[syllable.range.clone()]
                    .chars()
                    .any(char::is_alphabetic)
            });
        if !has_letters {
            return Err(LyricsError::NoLetters);
        }
        Ok(Lyrics {
            text: text.to_owned(),
            lines,
        })
    }

    /// The exact supplied bytes, including a leading byte-order mark.
    pub fn as_bytes(&self) -> &[u8] {
        self.text.as_bytes()
    }

    /// The exact supplied text, including a leading byte-order mark.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The lyric lines, in order. Blank and whitespace-only lines are not
    /// lyric lines.
    pub fn lines(&self) -> &[LyricLine] {
        &self.lines
    }
}

/// A line of the lyrics that holds at least one syllable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LyricLine {
    range: Range<usize>,
    syllables: Vec<Syllable>,
}

impl LyricLine {
    /// The byte range of the whole line, including leading and trailing
    /// whitespace but not its line ending.
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }

    /// The syllables of the line, in order.
    pub fn syllables(&self) -> &[Syllable] {
        &self.syllables
    }
}

/// A run of non-whitespace characters within a lyric line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Syllable {
    range: Range<usize>,
}

impl Syllable {
    /// The byte range of the syllable.
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }
}

/// Why lyrics were rejected. No message quotes the lyric text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LyricsError {
    /// The input is larger than `limit` bytes.
    TooLarge { len: usize, limit: usize },
    /// The input is not valid UTF-8. `offset` is the length of the valid
    /// prefix.
    InvalidUtf8 { offset: usize },
    /// The input contains a NUL character at byte `offset`.
    NulCharacter { offset: usize },
    /// No syllable contains a letter.
    NoLetters,
}

impl fmt::Display for LyricsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LyricsError::TooLarge { len, limit } => {
                write!(f, "lyrics are {len} bytes, over the limit of {limit} bytes")
            }
            LyricsError::InvalidUtf8 { offset } => {
                write!(f, "lyrics are not valid UTF-8 at byte {offset}")
            }
            LyricsError::NulCharacter { offset } => {
                write!(f, "lyrics contain a NUL character at byte {offset}")
            }
            LyricsError::NoLetters => write!(f, "lyrics contain no word with letters"),
        }
    }
}

impl std::error::Error for LyricsError {}

/// Reads the lyric lines of `text[start..]`. Ranges point into `text`.
///
/// LF, CRLF and a lone CR each end a line. Any other whitespace character
/// separates syllables. Lines without a syllable are left out.
fn read_lines(text: &str, start: usize) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    let mut line_start = start;
    let mut syllables = Vec::new();
    let mut syllable_start = None;
    let mut chars = text[start..]
        .char_indices()
        .map(|(index, c)| (index + start, c))
        .peekable();
    while let Some((index, c)) = chars.next() {
        if c == '\n' || c == '\r' {
            if let Some(begin) = syllable_start.take() {
                syllables.push(Syllable {
                    range: begin..index,
                });
            }
            if !syllables.is_empty() {
                lines.push(LyricLine {
                    range: line_start..index,
                    syllables: std::mem::take(&mut syllables),
                });
            }
            line_start = index + 1;
            if c == '\r' && chars.next_if(|&(_, next)| next == '\n').is_some() {
                line_start += 1;
            }
        } else if c.is_whitespace() {
            if let Some(begin) = syllable_start.take() {
                syllables.push(Syllable {
                    range: begin..index,
                });
            }
        } else if syllable_start.is_none() {
            syllable_start = Some(index);
        }
    }
    if let Some(begin) = syllable_start {
        syllables.push(Syllable {
            range: begin..text.len(),
        });
    }
    if !syllables.is_empty() {
        lines.push(LyricLine {
            range: line_start..text.len(),
            syllables,
        });
    }
    lines
}

#[cfg(test)]
// Expected syllable ranges are lists, and a line may hold one syllable.
#[allow(clippy::single_range_in_vec_init)]
mod tests {
    use super::*;

    /// The lyric lines of `lyrics` as (line range, syllable ranges).
    fn ranges(lyrics: &Lyrics) -> Vec<(Range<usize>, Vec<Range<usize>>)> {
        lyrics
            .lines()
            .iter()
            .map(|line| {
                let syllables = line.syllables().iter().map(Syllable::range).collect();
                (line.range(), syllables)
            })
            .collect()
    }

    /// The syllable texts of each lyric line.
    fn words(lyrics: &Lyrics) -> Vec<Vec<&str>> {
        lyrics
            .lines()
            .iter()
            .map(|line| {
                line.syllables()
                    .iter()
                    .map(|syllable| &lyrics.as_str()[syllable.range()])
                    .collect()
            })
            .collect()
    }

    fn parse(input: &str) -> Lyrics {
        Lyrics::parse(input.as_bytes()).expect("lyrics are accepted")
    }

    #[test]
    fn keeps_the_exact_bytes_of_vietnamese_lyrics() {
        let input = "Chiều nay   em về\r\n\r\n  bên dòng sông\tnhỏ \r\n";
        let lyrics = parse(input);
        assert_eq!(lyrics.as_bytes(), input.as_bytes());
        assert_eq!(lyrics.as_str(), input);
        assert_eq!(
            ranges(&lyrics),
            vec![
                (0..21, vec![0..7, 8..11, 14..16, 17..21]),
                (25..50, vec![27..31, 32..37, 38..43, 44..49]),
            ]
        );
        assert_eq!(
            words(&lyrics),
            vec![
                vec!["Chiều", "nay", "em", "về"],
                vec!["bên", "dòng", "sông", "nhỏ"],
            ]
        );
        assert_eq!(&input[lyrics.lines()[1].range()], "  bên dòng sông\tnhỏ ");
    }

    #[test]
    fn reads_a_single_line_without_a_line_ending() {
        let lyrics = parse("la la");
        assert_eq!(ranges(&lyrics), vec![(0..5, vec![0..2, 3..5])]);
    }

    #[test]
    fn ends_lines_at_lf() {
        let lyrics = parse("ab cd\nef\n");
        assert_eq!(
            ranges(&lyrics),
            vec![(0..5, vec![0..2, 3..5]), (6..8, vec![6..8])]
        );
    }

    #[test]
    fn ends_lines_at_crlf() {
        let lyrics = parse("ab cd\r\nef\r\n");
        assert_eq!(
            ranges(&lyrics),
            vec![(0..5, vec![0..2, 3..5]), (7..9, vec![7..9])]
        );
    }

    #[test]
    fn ends_lines_at_a_lone_cr() {
        let lyrics = parse("ab\rcd\r\ref");
        assert_eq!(
            ranges(&lyrics),
            vec![(0..2, vec![0..2]), (3..5, vec![3..5]), (7..9, vec![7..9]),]
        );
    }

    #[test]
    fn mixes_line_endings() {
        let lyrics = parse("a\r\nb\nc\rd");
        assert_eq!(
            words(&lyrics),
            vec![vec!["a"], vec!["b"], vec!["c"], vec!["d"]]
        );
        assert_eq!(
            ranges(&lyrics),
            vec![
                (0..1, vec![0..1]),
                (3..4, vec![3..4]),
                (5..6, vec![5..6]),
                (7..8, vec![7..8]),
            ]
        );
    }

    #[test]
    fn skips_blank_and_whitespace_only_lines() {
        let lyrics = parse("\n  \t \nab\n\n \r\ncd\n   ");
        assert_eq!(
            ranges(&lyrics),
            vec![(6..8, vec![6..8]), (13..15, vec![13..15])]
        );
    }

    #[test]
    fn line_range_keeps_leading_and_trailing_spaces() {
        let lyrics = parse("  ab  cd  \n");
        assert_eq!(ranges(&lyrics), vec![(0..10, vec![2..4, 6..8])]);
    }

    #[test]
    fn repeated_whitespace_never_makes_empty_syllables() {
        let lyrics = parse("a \t  b");
        assert_eq!(ranges(&lyrics), vec![(0..6, vec![0..1, 5..6])]);
    }

    #[test]
    fn no_break_space_separates_syllables() {
        let lyrics = parse("mưa\u{00A0}rơi");
        assert_eq!(ranges(&lyrics), vec![(0..10, vec![0..4, 6..10])]);
        assert_eq!(words(&lyrics), vec![vec!["mưa", "rơi"]]);
    }

    #[test]
    fn ideographic_space_and_line_separator_split_syllables_not_lines() {
        let lyrics = parse("ab\u{3000}cd\u{2028}ef");
        assert_eq!(ranges(&lyrics), vec![(0..12, vec![0..2, 5..7, 10..12])]);
    }

    #[test]
    fn punctuation_stays_in_its_syllable() {
        let lyrics = parse("Ơi, em! 123");
        assert_eq!(words(&lyrics), vec![vec!["Ơi,", "em!", "123"]]);
    }

    #[test]
    fn rejects_invalid_utf8() {
        let err = Lyrics::parse(&[b'a', 0xC3, 0x28]).unwrap_err();
        assert!(matches!(err, LyricsError::InvalidUtf8 { offset: 1 }));
    }

    #[test]
    fn rejects_input_over_the_size_limit() {
        let err = Lyrics::parse(&vec![b'a'; MAX_LYRICS_BYTES + 1]).unwrap_err();
        assert!(matches!(
            err,
            LyricsError::TooLarge {
                len: 1_048_577,
                limit: 1_048_576,
            }
        ));
    }

    #[test]
    fn accepts_input_of_exactly_the_size_limit() {
        let input = vec![b'a'; MAX_LYRICS_BYTES];
        let lyrics = Lyrics::parse(&input).expect("lyrics are accepted");
        assert_eq!(lyrics.as_bytes(), input.as_slice());
    }

    #[test]
    fn rejects_a_nul_character() {
        let err = Lyrics::parse(b"ba\0n").unwrap_err();
        assert!(matches!(err, LyricsError::NulCharacter { offset: 2 }));
    }

    #[test]
    fn rejects_input_without_letters() {
        for input in ["123 !!", "", " \r\n\t", "1\n2\n"] {
            let err = Lyrics::parse(input.as_bytes()).unwrap_err();
            assert!(matches!(err, LyricsError::NoLetters), "{input:?}");
        }
    }

    #[test]
    fn checks_size_before_utf8_before_nul_before_letters() {
        let mut too_large = vec![0xC3, 0x28, 0];
        too_large.resize(MAX_LYRICS_BYTES + 1, b'1');
        assert!(matches!(
            Lyrics::parse(&too_large).unwrap_err(),
            LyricsError::TooLarge { .. }
        ));
        assert!(matches!(
            Lyrics::parse(&[0, b'1', 0xC3, 0x28]).unwrap_err(),
            LyricsError::InvalidUtf8 { offset: 2 }
        ));
        assert!(matches!(
            Lyrics::parse(b"1\0").unwrap_err(),
            LyricsError::NulCharacter { offset: 1 }
        ));
    }

    #[test]
    fn error_messages_do_not_echo_the_lyrics() {
        let word = "Xuânthì";
        let mut too_large = format!("{word} ").into_bytes();
        too_large.resize(MAX_LYRICS_BYTES + 1, b'a');
        let mut invalid_utf8 = format!("{word} ").into_bytes();
        invalid_utf8.extend_from_slice(&[0xC3, 0x28]);
        let cases = [
            (too_large, word),
            (invalid_utf8, word),
            (format!("{word}\0").into_bytes(), word),
            (b"#4271!! 9".to_vec(), "#4271!!"),
        ];
        for (input, distinctive) in &cases {
            let message = Lyrics::parse(input).unwrap_err().to_string();
            assert!(!message.contains(distinctive), "{message}");
        }
    }

    #[test]
    fn error_messages_state_the_reason() {
        assert_eq!(
            LyricsError::TooLarge {
                len: 1_048_577,
                limit: 1_048_576
            }
            .to_string(),
            "lyrics are 1048577 bytes, over the limit of 1048576 bytes"
        );
        assert_eq!(
            LyricsError::InvalidUtf8 { offset: 4 }.to_string(),
            "lyrics are not valid UTF-8 at byte 4"
        );
        assert_eq!(
            LyricsError::NulCharacter { offset: 7 }.to_string(),
            "lyrics contain a NUL character at byte 7"
        );
        assert_eq!(
            LyricsError::NoLetters.to_string(),
            "lyrics contain no word with letters"
        );
    }

    #[test]
    fn keeps_a_leading_bom_and_shifts_ranges_by_its_length() {
        let without_bom = "Chiều nay   em về\r\n\r\n  bên dòng sông\tnhỏ \r\n";
        let with_bom = format!("\u{FEFF}{without_bom}");
        assert_eq!(&with_bom.as_bytes()[..3], b"\xEF\xBB\xBF");

        let plain = parse(without_bom);
        let lyrics = parse(&with_bom);
        assert_eq!(lyrics.as_bytes(), with_bom.as_bytes());

        let shifted: Vec<_> = ranges(&plain)
            .into_iter()
            .map(|(line, syllables)| {
                let syllables = syllables
                    .into_iter()
                    .map(|syllable| syllable.start + 3..syllable.end + 3)
                    .collect();
                (line.start + 3..line.end + 3, syllables)
            })
            .collect();
        assert_eq!(ranges(&lyrics), shifted);
        assert_eq!(words(&lyrics), words(&plain));
        assert_eq!(lyrics.lines()[0].range().start, 3);
        assert!(!words(&lyrics)[0][0].starts_with('\u{FEFF}'));
    }

    #[test]
    fn a_leading_bom_counts_toward_the_size_limit() {
        let mut input = BOM.to_vec();
        input.resize(MAX_LYRICS_BYTES + 1, b'a');
        assert!(matches!(
            Lyrics::parse(&input).unwrap_err(),
            LyricsError::TooLarge { len: 1_048_577, .. }
        ));

        input.truncate(MAX_LYRICS_BYTES);
        let lyrics = Lyrics::parse(&input).expect("lyrics are accepted");
        assert_eq!(lyrics.as_bytes(), input.as_slice());
    }

    #[test]
    fn keeps_a_bom_in_the_middle_inside_its_syllable() {
        let input = "\u{FEFF}ab \u{FEFF}cd";
        let lyrics = parse(input);
        assert_eq!(lyrics.as_bytes(), input.as_bytes());
        assert_eq!(ranges(&lyrics), vec![(3..11, vec![3..5, 6..11])]);
        assert_eq!(words(&lyrics), vec![vec!["ab", "\u{FEFF}cd"]]);
    }

    #[test]
    fn rejects_a_bom_alone() {
        assert!(matches!(
            Lyrics::parse(BOM).unwrap_err(),
            LyricsError::NoLetters
        ));
    }
}
