//! The timing file: hand-written timing for a development song file.
//!
//! The format and its rules are in `docs/reference/lyre-cli.md#timing-file`.
//! Each timed line gives one syllable's start and end in milliseconds, then
//! the syllable exactly as the lyrics have it. Blank lines and lines starting
//! with `#` are skipped. A file that breaks a rule is rejected at the first
//! line that breaks it. No error message quotes the file or the lyrics.

use std::fmt;

use crate::lyrics::Lyrics;
use crate::song_file::SyllableTime;

/// The UTF-8 byte-order mark, skipped at the start of the file.
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Reads the timing file `text` against `lyrics`. Returns one time per
/// syllable of the lyrics, in lyric order.
pub fn parse(text: &[u8], lyrics: &Lyrics) -> Result<Vec<SyllableTime>, TimingFileError> {
    let expected: Vec<&str> = lyrics
        .lines()
        .iter()
        .flat_map(|line| line.syllables())
        .map(|syllable| &lyrics.as_str()[syllable.range()])
        .collect();
    let text = text.strip_prefix(BOM).unwrap_or(text);
    // A final line ending does not start another line.
    let body = text.strip_suffix(b"\n").unwrap_or(text);
    let mut line_count = 0;
    let mut times: Vec<SyllableTime> = Vec::with_capacity(expected.len());
    if !text.is_empty() {
        for (index, raw) in body.split(|&byte| byte == b'\n').enumerate() {
            let line = index + 1;
            line_count = line;
            let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
            let fail = |kind| Err(TimingFileError { line, kind });
            // A comment is skipped before decoding, so it need not be UTF-8.
            if raw.trim_ascii_start().starts_with(b"#") {
                continue;
            }
            let Ok(content) = std::str::from_utf8(raw) else {
                return fail(TimingErrorKind::Malformed);
            };
            let content = content.trim_start();
            if content.is_empty() || content.starts_with('#') {
                continue;
            }
            let Some((start_ms, end_ms, name)) = fields(content) else {
                return fail(TimingErrorKind::Malformed);
            };

            let position = times.len();
            if expected.get(position) != Some(&name) {
                let syllable = position + 1;
                return if expected.get(position + 1) == Some(&name) {
                    fail(TimingErrorKind::MissingSyllable { syllable })
                } else {
                    fail(TimingErrorKind::UnknownSyllable { syllable })
                };
            }
            let previous = times.last();
            if end_ms <= start_ms || previous.is_some_and(|p| start_ms < p.start_ms) {
                return fail(TimingErrorKind::Backwards);
            }
            if previous.is_some_and(|p| start_ms < p.end_ms) {
                return fail(TimingErrorKind::Overlap);
            }
            times.push(SyllableTime { start_ms, end_ms });
        }
    }
    if times.len() < expected.len() {
        return Err(TimingFileError {
            line: line_count + 1,
            kind: TimingErrorKind::MissingSyllable {
                syllable: times.len() + 1,
            },
        });
    }
    Ok(times)
}

/// Splits a timed line into its start, its end and its syllable. `None`
/// when it does not have exactly these three fields.
fn fields(content: &str) -> Option<(u32, u32, &str)> {
    let mut parts = content.split_whitespace();
    let start_ms = millis(parts.next()?)?;
    let end_ms = millis(parts.next()?)?;
    let name = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    Some((start_ms, end_ms, name))
}

/// Reads a time written in ASCII digits.
fn millis(field: &str) -> Option<u32> {
    if !field.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    field.parse().ok()
}

/// Why a timing file was rejected, and the line it happened on. Lines count
/// from 1, and every line counts, including comments and blank lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingFileError {
    pub line: usize,
    pub kind: TimingErrorKind,
}

/// The rule a timing file broke. Syllables count from 1, in lyric order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimingErrorKind {
    /// The line is not a start, an end and a syllable, or is not UTF-8.
    Malformed,
    /// The line names a syllable that is not `syllable` of the lyrics, or
    /// the lyrics have no syllable left for it.
    UnknownSyllable { syllable: usize },
    /// Syllable `syllable` of the lyrics has no line: this line names the one
    /// after it, or the file ends before it.
    MissingSyllable { syllable: usize },
    /// The syllable ends at or before its start, or starts before the
    /// previous syllable starts.
    Backwards,
    /// The syllable starts before the previous syllable ends.
    Overlap,
}

impl fmt::Display for TimingFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let line = self.line;
        match self.kind {
            TimingErrorKind::Malformed => write!(
                f,
                "line {line}: expected a start in ms, an end in ms and a syllable"
            ),
            TimingErrorKind::UnknownSyllable { syllable } => write!(
                f,
                "line {line}: the syllable named is not syllable {syllable} of the lyrics"
            ),
            TimingErrorKind::MissingSyllable { syllable } => {
                write!(
                    f,
                    "line {line}: syllable {syllable} of the lyrics is missing"
                )
            }
            TimingErrorKind::Backwards => write!(
                f,
                "line {line}: the syllable ends before it starts or starts before the previous one"
            ),
            TimingErrorKind::Overlap => write!(
                f,
                "line {line}: the syllable starts before the previous one ends"
            ),
        }
    }
}

impl std::error::Error for TimingFileError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn lyrics() -> Lyrics {
        Lyrics::parse(b"a b\n\nc").expect("valid lyrics")
    }

    fn time(start_ms: u32, end_ms: u32) -> SyllableTime {
        SyllableTime { start_ms, end_ms }
    }

    /// The error for `text` read against `lyrics()`.
    fn error(text: &str) -> TimingFileError {
        parse(text.as_bytes(), &lyrics()).expect_err("timing is rejected")
    }

    fn at(line: usize, kind: TimingErrorKind) -> TimingFileError {
        TimingFileError { line, kind }
    }

    #[test]
    fn accepts_timing_with_comments_and_blank_lines() {
        let text = "# start end syllable\n0 100 a\n\n  # gap\n100 250 b\r\n400 500 c\n";
        let times = parse(text.as_bytes(), &lyrics()).expect("timing is accepted");
        assert_eq!(times, vec![time(0, 100), time(100, 250), time(400, 500)]);
    }

    #[test]
    fn accepts_a_leading_byte_order_mark_and_no_final_line_ending() {
        let text = b"\xEF\xBB\xBF0 100 a\n100 200 b\n200 300 c";
        let times = parse(text, &lyrics()).expect("timing is accepted");
        assert_eq!(times.len(), 3);
    }

    #[test]
    fn rejects_a_syllable_not_in_the_lyrics() {
        let err = error("# header\n0 100 a\n100 200 x\n200 300 c\n");
        assert_eq!(err, at(3, TimingErrorKind::UnknownSyllable { syllable: 2 }));
    }

    #[test]
    fn rejects_an_extra_line() {
        let err = error("0 100 a\n100 200 b\n200 300 c\n\n300 400 c\n");
        assert_eq!(err, at(5, TimingErrorKind::UnknownSyllable { syllable: 4 }));
    }

    #[test]
    fn rejects_a_missed_syllable_in_the_middle() {
        let err = error("0 100 a\n# b is left out\n200 300 c\n");
        assert_eq!(err, at(3, TimingErrorKind::MissingSyllable { syllable: 2 }));
    }

    #[test]
    fn rejects_a_missed_syllable_at_the_end() {
        let err = error("0 100 a\n100 200 b\n\n");
        assert_eq!(err, at(4, TimingErrorKind::MissingSyllable { syllable: 3 }));
        let err = error("0 100 a\n100 200 b");
        assert_eq!(err, at(3, TimingErrorKind::MissingSyllable { syllable: 3 }));
        let err = error("");
        assert_eq!(err, at(1, TimingErrorKind::MissingSyllable { syllable: 1 }));
    }

    #[test]
    fn rejects_a_syllable_that_ends_at_or_before_its_start() {
        assert_eq!(
            error("0 100 a\n200 200 b\n300 400 c\n"),
            at(2, TimingErrorKind::Backwards)
        );
        assert_eq!(
            error("0 100 a\n100 200 b\n500 400 c\n"),
            at(3, TimingErrorKind::Backwards)
        );
    }

    #[test]
    fn rejects_a_syllable_that_starts_before_the_previous_start() {
        let err = error("100 200 a\n50 300 b\n300 400 c\n");
        assert_eq!(err, at(2, TimingErrorKind::Backwards));
    }

    #[test]
    fn rejects_overlapping_syllables() {
        let err = error("0 100 a\n100 200 b\n150 300 c\n");
        assert_eq!(err, at(3, TimingErrorKind::Overlap));
    }

    #[test]
    fn rejects_malformed_lines() {
        for line in [
            "0 100",
            "0 100 a extra",
            "zero 100 a",
            "-1 100 a",
            "+0 100 a",
            "0 4294967296 a",
        ] {
            let text = format!("# header\n{line}\n");
            assert_eq!(error(&text), at(2, TimingErrorKind::Malformed), "{line}");
        }
        let err = parse(b"0 100 a\n100 200 \xFF\n", &lyrics()).expect_err("rejected");
        assert_eq!(err, at(2, TimingErrorKind::Malformed));
    }

    #[test]
    fn messages_never_quote_the_lyrics_or_the_line() {
        let lyrics = Lyrics::parse("Mưa rơi\n\nnhẹ".as_bytes()).expect("valid lyrics");
        let files = [
            "0 100 Mưa\n100 200 rơi\n200 300 nhẹ\n200 300 nhẹ\n",
            "0 100 Mưa\n100 200 qzx\n",
            "0 100 Mưa\n200 300 nhẹ\n",
            "0 100 Mưa\n",
            "0 100 Mưa\n50 200 rơi\n",
            "0 100 Mưa\n80 200 rơi\n",
            "0 100 Mưa qzx\n",
        ];
        for file in files {
            let err = parse(file.as_bytes(), &lyrics).expect_err("timing is rejected");
            let message = err.to_string();
            assert!(message.starts_with(&format!("line {}: ", err.line)));
            for text in ["Mưa", "rơi", "nhẹ", "qzx"] {
                assert!(!message.contains(text), "{message}");
            }
        }
    }
}
