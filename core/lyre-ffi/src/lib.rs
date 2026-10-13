//! UniFFI bindings of the Lyre core, for the Android app.

use std::fmt;

use lyre_core::alignment::{self, AlignmentError, Emissions};
use lyre_core::lyrics::Lyrics;

uniffi::setup_scaffolding!();

/// The version of the Lyre core.
#[uniffi::export]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
}

/// When one aligned syllable is sung, and how sure the model is of it, from
/// 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct AlignedSyllable {
    pub start_ms: u32,
    pub end_ms: u32,
    pub confidence: f32,
}

/// Why alignment failed. It holds no core message, because those are not
/// meant for users.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Error)]
pub enum AlignmentFault {
    /// Syllable `position` of lyric line `lyric_line`, both counting from 0,
    /// has no character the model knows.
    UnknownSyllable { lyric_line: u32, position: u32 },
    /// The input was refused for any other reason.
    Rejected,
}

impl fmt::Display for AlignmentFault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AlignmentFault::UnknownSyllable {
                lyric_line,
                position,
            } => write!(
                f,
                "syllable {} of lyric line {} has no character the model knows",
                position + 1,
                lyric_line + 1
            ),
            AlignmentFault::Rejected => write!(f, "alignment refused the input"),
        }
    }
}

impl std::error::Error for AlignmentFault {}

impl From<AlignmentError> for AlignmentFault {
    fn from(error: AlignmentError) -> AlignmentFault {
        match error {
            // Lyrics are at most 1 MiB, so every index fits.
            AlignmentError::UnknownSyllable {
                lyric_line,
                position,
            } => AlignmentFault::UnknownSyllable {
                lyric_line: lyric_line as u32,
                position: position as u32,
            },
            _ => AlignmentFault::Rejected,
        }
    }
}

/// Times every syllable of `lyrics` from a CTC model's output for the whole
/// song: `log_probs` holds `frames × vocabulary.size` natural-log
/// probabilities, frame by frame. `blank` is the blank token's index,
/// `frame_us` the frame length in microseconds and `song_ms` the song's
/// duration. It returns one time per syllable, in lyric order.
#[uniffi::export]
pub fn align(
    lyrics: Vec<u8>,
    log_probs: Vec<f32>,
    vocabulary: Vec<String>,
    blank: u32,
    frame_us: u32,
    song_ms: u32,
) -> Result<Vec<AlignedSyllable>, AlignmentFault> {
    let lyrics = Lyrics::parse(&lyrics).map_err(|_| AlignmentFault::Rejected)?;
    let emissions = Emissions {
        log_probs: &log_probs,
        vocabulary: &vocabulary,
        blank: blank as usize,
        frame_us,
    };
    let alignment = alignment::align(&lyrics, &emissions, song_ms)?;
    Ok(alignment
        .timing
        .syllables()
        .iter()
        .zip(alignment.confidence)
        .map(|(time, confidence)| AlignedSyllable {
            start_ms: time.start_ms,
            end_ms: time.end_ms,
            confidence,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The known-answer vocabulary. The blank is entry 0.
    const VOCABULARY: [&str; 7] = ["<pad>", "m", "ư", "a", "r", "\u{1A1}", "i"];

    /// Frames for "Mưa rơi": "Mưa" in frames 1 to 3 and "rơi" in frames 6
    /// to 8, each best token at probability 0.9.
    fn frames() -> Vec<f32> {
        let best = [0, 1, 2, 3, 0, 0, 4, 5, 6, 0];
        let rest = (0.1f64 / 6.0).ln() as f32;
        let mut log_probs = vec![rest; 7 * best.len()];
        for (frame, &token) in best.iter().enumerate() {
            log_probs[frame * 7 + token] = 0.9f64.ln() as f32;
        }
        log_probs
    }

    fn align_known_answer(lyrics: &str) -> Result<Vec<AlignedSyllable>, AlignmentFault> {
        let vocabulary = VOCABULARY.map(str::to_owned).to_vec();
        align(
            lyrics.as_bytes().to_vec(),
            frames(),
            vocabulary,
            0,
            20_000,
            1_000,
        )
    }

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }

    #[test]
    fn aligns_the_known_answer() {
        let syllables = align_known_answer("Mưa r\u{1A1}i").expect("it aligns");
        let times: Vec<_> = syllables.iter().map(|s| (s.start_ms, s.end_ms)).collect();
        assert_eq!(times, vec![(20, 80), (120, 180)]);
        assert!(syllables.iter().all(|s| (s.confidence - 0.9).abs() < 1e-6));
    }

    #[test]
    fn alignment_names_the_unknown_syllable() {
        assert_eq!(
            align_known_answer("Mưa ♪\r\nrơi 2"),
            Err(AlignmentFault::UnknownSyllable {
                lyric_line: 0,
                position: 1
            })
        );
        assert_eq!(align_known_answer(""), Err(AlignmentFault::Rejected));
    }
}
