//! Onset error: how far each aligned syllable starts from the start written
//! by hand, for the model measurement in `docs/roadmap.md`, under "Early
//! checks on real devices".
//!
//! Only start times matter. Both timings list one start per syllable of the
//! same lyrics, in lyric order.

use std::fmt;

use crate::song_file;

/// The error, in milliseconds, at or under which a syllable counts as
/// within the mark.
pub const WITHIN_MS: u32 = 100;

/// The onset error of every syllable, and its statistics.
///
/// A syllable's error is the absolute difference between its two starts.
/// The median and the 90th percentile interpolate linearly between ranks:
/// over the `n` errors sorted up, percentile `p` sits at rank
/// `(n - 1) * p`, counting from 0. `within_100_ms` is the share, from 0 to
/// 1, of errors at or under [`WITHIN_MS`].
#[derive(Debug, Clone, PartialEq)]
pub struct OnsetErrors {
    /// Each syllable's error, in lyric order.
    pub errors_ms: Vec<u32>,
    pub median_ms: f64,
    pub p90_ms: f64,
    pub within_100_ms: f64,
}

/// Why two timings cannot be measured against each other.
#[derive(Debug, Clone, PartialEq)]
pub enum MeasureError {
    /// The timings have no syllables.
    Empty,
    /// The timings have more than `limit` syllables.
    TooManySyllables { count: usize, limit: usize },
    /// The timings have different numbers of syllables.
    CountMismatch { hand: usize, aligned: usize },
}

/// Measures the onset error of `aligned_onsets_ms` against
/// `hand_onsets_ms`, the starts written by hand. Both give one start per
/// syllable, in milliseconds.
pub fn measure(
    hand_onsets_ms: &[u32],
    aligned_onsets_ms: &[u32],
) -> Result<OnsetErrors, MeasureError> {
    let count = hand_onsets_ms.len();
    if aligned_onsets_ms.len() != count {
        return Err(MeasureError::CountMismatch {
            hand: count,
            aligned: aligned_onsets_ms.len(),
        });
    }
    if count == 0 {
        return Err(MeasureError::Empty);
    }
    if count > song_file::MAX_SYLLABLES {
        return Err(MeasureError::TooManySyllables {
            count,
            limit: song_file::MAX_SYLLABLES,
        });
    }
    let errors_ms: Vec<u32> = hand_onsets_ms
        .iter()
        .zip(aligned_onsets_ms)
        .map(|(hand, aligned)| hand.abs_diff(*aligned))
        .collect();
    let mut sorted = errors_ms.clone();
    sorted.sort_unstable();
    let within = sorted.iter().filter(|&&error| error <= WITHIN_MS).count();
    Ok(OnsetErrors {
        median_ms: percentile(&sorted, 0.5),
        p90_ms: percentile(&sorted, 0.9),
        // The count is at most `MAX_SYLLABLES`, so both are exact as f64.
        within_100_ms: within as f64 / count as f64,
        errors_ms,
    })
}

/// Percentile `p` of `sorted`, which is sorted up and not empty, by linear
/// interpolation between ranks.
fn percentile(sorted: &[u32], p: f64) -> f64 {
    let rank = (sorted.len() - 1) as f64 * p;
    // The rank is within the slice, so both indexes are too.
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    let low = f64::from(sorted[lo]);
    let high = f64::from(sorted[hi]);
    low + (rank - rank.floor()) * (high - low)
}

impl fmt::Display for MeasureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MeasureError::Empty => write!(f, "the timings have no syllables"),
            MeasureError::TooManySyllables { count, limit } => write!(
                f,
                "the timings have {count} syllables, over the limit of {limit}"
            ),
            MeasureError::CountMismatch { hand, aligned } => write!(
                f,
                "the hand-written timing has {hand} syllables but the aligned one has {aligned}"
            ),
        }
    }
}

impl std::error::Error for MeasureError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_answer() {
        let hand = [0, 1000, 2000, 3000, 4000];
        let aligned = [50, 1150, 1900, 3300, 4000];
        let measured = measure(&hand, &aligned).expect("timings are measured");
        assert_eq!(
            measured,
            OnsetErrors {
                errors_ms: vec![50, 150, 100, 300, 0],
                median_ms: 100.0,
                p90_ms: 240.0,
                within_100_ms: 0.6,
            }
        );
    }

    #[test]
    fn median_of_an_even_count_is_the_mean_of_the_middle_two() {
        let measured = measure(&[0, 0, 0, 0], &[30, 0, 20, 10]).expect("measured");
        assert_eq!(measured.errors_ms, vec![30, 0, 20, 10]);
        assert_eq!(measured.median_ms, 15.0);
        assert_eq!(measured.p90_ms, 27.0);
        assert_eq!(measured.within_100_ms, 1.0);
    }

    #[test]
    fn one_syllable_gives_its_error_for_every_statistic() {
        let measured = measure(&[500], &[620]).expect("measured");
        assert_eq!(measured.errors_ms, vec![120]);
        assert_eq!(measured.median_ms, 120.0);
        assert_eq!(measured.p90_ms, 120.0);
        assert_eq!(measured.within_100_ms, 0.0);
    }

    #[test]
    fn counts_an_error_of_exactly_the_mark_as_within() {
        let measured = measure(&[0, 0], &[100, 101]).expect("measured");
        assert_eq!(measured.within_100_ms, 0.5);
    }

    #[test]
    fn handles_the_largest_starts() {
        let measured = measure(&[0], &[u32::MAX]).expect("measured");
        assert_eq!(measured.errors_ms, vec![u32::MAX]);
        assert_eq!(measured.median_ms, f64::from(u32::MAX));
    }

    #[test]
    fn refuses_different_syllable_counts() {
        assert_eq!(
            measure(&[0, 100], &[0, 100, 200]),
            Err(MeasureError::CountMismatch {
                hand: 2,
                aligned: 3
            })
        );
    }

    #[test]
    fn refuses_empty_timings() {
        assert_eq!(measure(&[], &[]), Err(MeasureError::Empty));
    }

    #[test]
    fn refuses_more_syllables_than_a_timing_holds() {
        let starts = vec![0; song_file::MAX_SYLLABLES + 1];
        assert_eq!(
            measure(&starts, &starts),
            Err(MeasureError::TooManySyllables {
                count: song_file::MAX_SYLLABLES + 1,
                limit: song_file::MAX_SYLLABLES,
            })
        );
        let starts = vec![0; song_file::MAX_SYLLABLES];
        assert!(measure(&starts, &starts).is_ok());
    }
}
