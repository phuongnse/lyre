//! The highlight: how far it has swept through the syllables at a media
//! time.
//!
//! The rules are in `docs/domain/knowledge.md`, under "Lyrics". The
//! highlight goes syllable by syllable. Within the syllable being sung, it
//! sweeps from its start time to its end time. Both clients call this, so
//! the sweep is the same on the web and on Android.

use crate::song_file::SyllableTime;

/// How far the highlight has swept at `ms`: the syllables already sung, plus
/// the fraction of the one being sung. `syllables` are in order and never
/// overlap, as a checked `Timing` guarantees.
///
/// A syllable is sung once `ms` reaches its end. Between two syllables the
/// result is a whole number. A time that is not a number, or is negative,
/// gives 0.
pub fn sweep_position(syllables: &[SyllableTime], ms: f64) -> f64 {
    if ms.is_nan() || ms < 0.0 {
        return 0.0;
    }
    let sung = syllables.partition_point(|s| f64::from(s.end_ms) <= ms);
    let fraction = match syllables.get(sung) {
        Some(s) if f64::from(s.start_ms) <= ms => {
            let start = f64::from(s.start_ms);
            (ms - start) / (f64::from(s.end_ms) - start)
        }
        _ => 0.0,
    };
    sung as f64 + fraction
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two syllables, 100–300 ms and 500–600 ms, with a gap between them.
    fn timing() -> Vec<SyllableTime> {
        vec![
            SyllableTime {
                start_ms: 100,
                end_ms: 300,
            },
            SyllableTime {
                start_ms: 500,
                end_ms: 600,
            },
        ]
    }

    #[test]
    fn is_zero_before_the_first_syllable() {
        assert_eq!(sweep_position(&timing(), 0.0), 0.0);
        assert_eq!(sweep_position(&timing(), 99.9), 0.0);
    }

    #[test]
    fn is_zero_at_the_start_of_the_first_syllable() {
        assert_eq!(sweep_position(&timing(), 100.0), 0.0);
    }

    #[test]
    fn is_half_way_through_the_first_syllable() {
        assert_eq!(sweep_position(&timing(), 200.0), 0.5);
    }

    #[test]
    fn counts_a_syllable_as_sung_exactly_at_its_end() {
        assert_eq!(sweep_position(&timing(), 300.0), 1.0);
    }

    #[test]
    fn is_the_sung_count_in_a_gap() {
        assert_eq!(sweep_position(&timing(), 400.0), 1.0);
        assert_eq!(sweep_position(&timing(), 499.0), 1.0);
    }

    #[test]
    fn sweeps_the_second_syllable() {
        assert_eq!(sweep_position(&timing(), 525.0), 1.25);
    }

    #[test]
    fn is_the_syllable_count_after_the_last_syllable() {
        assert_eq!(sweep_position(&timing(), 600.0), 2.0);
        assert_eq!(sweep_position(&timing(), 1_000_000.0), 2.0);
        assert_eq!(sweep_position(&timing(), f64::INFINITY), 2.0);
    }

    #[test]
    fn is_zero_for_a_time_that_is_not_a_number_or_negative() {
        assert_eq!(sweep_position(&timing(), f64::NAN), 0.0);
        assert_eq!(sweep_position(&timing(), -1.0), 0.0);
        assert_eq!(sweep_position(&timing(), f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn is_zero_without_syllables() {
        assert_eq!(sweep_position(&[], 500.0), 0.0);
    }
}
