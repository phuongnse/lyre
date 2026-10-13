//! The countdown dots: which lyric lines have them, and how far the sweep
//! across them has got at a media time.
//!
//! The rules are in `docs/ui-conventions.md`, under "Countdown dots". Each dot
//! is swept from left to right during its step, like a syllable. Both clients
//! call this, so the dots are the same on the web and on Android.

use crate::lyrics::Lyrics;
use crate::song_file::SyllableTime;

/// A break of this length or longer before a lyric line gives it a
/// countdown, in milliseconds.
pub const BREAK_MS: u32 = 5_000;
/// The longest a step takes, in milliseconds.
pub const STEP_MS: f64 = 500.0;
/// How many dots a countdown has, and so how many steps.
pub const DOTS: u32 = 4;

/// The countdown before one lyric line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Countdown {
    /// The index of the lyric line the dots come before.
    pub lyric_line: usize,
    /// Where the gap starts: 0 for the first lyric line, or else the end of
    /// the previous line's last syllable.
    pub from_ms: u32,
    /// Where the gap ends: the start of this line's first syllable.
    pub to_ms: u32,
}

/// The lyric lines that have a countdown, in order. The first lyric line
/// always has one. Any other line has one after a break of [`BREAK_MS`] or
/// longer.
///
/// `syllables` are the times of every syllable of `lyrics`, in order. If
/// they run out before the lyrics do, the lines left have no countdown.
pub fn countdowns(lyrics: &Lyrics, syllables: &[SyllableTime]) -> Vec<Countdown> {
    let mut result = Vec::new();
    let mut offset = 0;
    let mut previous_end = None;
    for (lyric_line, line) in lyrics.lines().iter().enumerate() {
        let count = line.syllables().len();
        let Some(times) = syllables.get(offset..offset + count) else {
            break;
        };
        offset += count;
        let (Some(first), Some(last)) = (times.first(), times.last()) else {
            continue;
        };
        let from_ms = previous_end.unwrap_or(0);
        let has_countdown =
            previous_end.is_none_or(|end| first.start_ms.saturating_sub(end) >= BREAK_MS);
        if has_countdown {
            result.push(Countdown {
                lyric_line,
                from_ms,
                to_ms: first.start_ms,
            });
        }
        previous_end = Some(last.end_ms);
    }
    result
}

/// The total number of dots swept at `ms`, across every countdown, with the
/// fraction of the dot being swept. Countdown `k`, counting from 0, shows
/// `clamp(total - 4k, 0, 4)` dots swept.
///
/// Each step takes [`STEP_MS`], or a quarter of the gap when the gap is
/// shorter than four steps. The last step ends where the gap ends. A time
/// that is not a number, or is negative, gives 0.
pub fn dots_swept(countdowns: &[Countdown], ms: f64) -> f64 {
    if ms.is_nan() || ms < 0.0 {
        return 0.0;
    }
    let dots = f64::from(DOTS);
    countdowns
        .iter()
        .map(|countdown| {
            let to = f64::from(countdown.to_ms);
            let gap = f64::from(countdown.to_ms.saturating_sub(countdown.from_ms));
            let step = STEP_MS.min(gap / dots);
            if step == 0.0 {
                return if ms >= to { dots } else { 0.0 };
            }
            let start = to - dots * step;
            ((ms - start) / step).clamp(0.0, dots)
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(start_ms: u32, end_ms: u32) -> SyllableTime {
        SyllableTime { start_ms, end_ms }
    }

    /// One countdown, with the gap from `from_ms` to `to_ms`.
    fn one(from_ms: u32, to_ms: u32) -> Vec<Countdown> {
        vec![Countdown {
            lyric_line: 0,
            from_ms,
            to_ms,
        }]
    }

    /// Two lyric lines. The second starts `gap` ms after the first ends.
    fn two_lines(gap: u32) -> Vec<Countdown> {
        let lyrics = Lyrics::parse(b"a\nb").expect("valid lyrics");
        countdowns(&lyrics, &[time(0, 1_000), time(1_000 + gap, 2_000 + gap)])
    }

    #[test]
    fn the_first_line_always_has_a_countdown() {
        let lyrics = Lyrics::parse(b"a b").expect("valid lyrics");
        let result = countdowns(&lyrics, &[time(1_200, 1_500), time(1_500, 1_800)]);
        assert_eq!(result, one(0, 1_200));
        let result = countdowns(&lyrics, &[time(0, 500), time(500, 1_000)]);
        assert_eq!(result, one(0, 0));
    }

    #[test]
    fn a_break_of_exactly_5000_ms_gives_a_countdown() {
        let lines: Vec<usize> = two_lines(5_000).iter().map(|c| c.lyric_line).collect();
        assert_eq!(lines, vec![0, 1]);
        assert_eq!(
            two_lines(5_000)[1],
            Countdown {
                lyric_line: 1,
                from_ms: 1_000,
                to_ms: 6_000
            }
        );
    }

    #[test]
    fn a_break_of_4999_ms_gives_none() {
        let lines: Vec<usize> = two_lines(4_999).iter().map(|c| c.lyric_line).collect();
        assert_eq!(lines, vec![0]);
    }

    #[test]
    fn the_gap_runs_from_the_last_syllable_of_the_previous_line() {
        let lyrics = Lyrics::parse(b"a b\nc").expect("valid lyrics");
        let times = [time(0, 400), time(400, 1_000), time(6_000, 6_500)];
        let result = countdowns(&lyrics, &times);
        assert_eq!(
            result[1],
            Countdown {
                lyric_line: 1,
                from_ms: 1_000,
                to_ms: 6_000
            }
        );
    }

    #[test]
    fn lines_without_times_have_no_countdown() {
        let lyrics = Lyrics::parse(b"a\nb\nc").expect("valid lyrics");
        let times = [time(0, 100), time(10_000, 10_100)];
        let lines: Vec<usize> = countdowns(&lyrics, &times)
            .iter()
            .map(|c| c.lyric_line)
            .collect();
        assert_eq!(lines, vec![0, 1]);
        assert_eq!(countdowns(&lyrics, &[]), vec![]);
    }

    #[test]
    fn sweeps_one_dot_each_quarter_of_a_short_gap() {
        let countdowns = one(0, 1_200);
        assert_eq!(dots_swept(&countdowns, 0.0), 0.0);
        assert_eq!(dots_swept(&countdowns, 300.0), 1.0);
        assert_eq!(dots_swept(&countdowns, 450.0), 1.5);
        assert_eq!(dots_swept(&countdowns, 600.0), 2.0);
        assert_eq!(dots_swept(&countdowns, 900.0), 3.0);
        assert_eq!(dots_swept(&countdowns, 1_200.0), 4.0);
        assert_eq!(dots_swept(&countdowns, 1_000_000.0), 4.0);
        assert_eq!(dots_swept(&countdowns, f64::INFINITY), 4.0);
    }

    #[test]
    fn sweeps_one_dot_each_half_second_before_a_long_gap_ends() {
        let countdowns = one(0, 3_000);
        assert_eq!(dots_swept(&countdowns, 999.0), 0.0);
        assert_eq!(dots_swept(&countdowns, 1_000.0), 0.0);
        assert_eq!(dots_swept(&countdowns, 1_250.0), 0.5);
        assert_eq!(dots_swept(&countdowns, 1_500.0), 1.0);
        assert_eq!(dots_swept(&countdowns, 2_000.0), 2.0);
        assert_eq!(dots_swept(&countdowns, 2_750.0), 3.5);
        assert_eq!(dots_swept(&countdowns, 3_000.0), 4.0);
    }

    #[test]
    fn uses_a_step_of_a_quarter_of_a_gap_that_is_not_whole() {
        let countdowns = one(0, 1_001);
        assert_eq!(dots_swept(&countdowns, 500.5), 2.0);
        assert_eq!(dots_swept(&countdowns, 750.75), 3.0);
        assert_eq!(dots_swept(&countdowns, 1_001.0), 4.0);
    }

    #[test]
    fn sweeps_the_four_dots_of_a_gap_of_2000_ms_half_a_second_apart() {
        let countdowns = one(0, 2_000);
        assert_eq!(dots_swept(&countdowns, 0.0), 0.0);
        assert_eq!(dots_swept(&countdowns, 500.0), 1.0);
        assert_eq!(dots_swept(&countdowns, 2_000.0), 4.0);
    }

    #[test]
    fn sweeps_all_four_dots_at_once_for_a_line_at_time_zero() {
        assert_eq!(dots_swept(&one(0, 0), 0.0), 4.0);
    }

    #[test]
    fn sweeps_all_four_dots_at_once_for_a_gap_of_zero() {
        let countdowns = one(3_000, 3_000);
        assert_eq!(dots_swept(&countdowns, 2_999.0), 0.0);
        assert_eq!(dots_swept(&countdowns, 3_000.0), 4.0);
    }

    #[test]
    fn adds_up_the_dots_of_every_countdown() {
        let countdowns = two_lines(5_000);
        assert_eq!(dots_swept(&countdowns, 0.0), 4.0);
        assert_eq!(dots_swept(&countdowns, 4_500.0), 5.0);
        assert_eq!(dots_swept(&countdowns, 6_000.0), 8.0);
    }

    #[test]
    fn sweeps_the_fixture_countdown_from_7_9_to_9_9_seconds() {
        let lyrics = Lyrics::parse("Mưa rơi nhẹ\n\nEm về bên sông\n\nTrăng lên".as_bytes())
            .expect("valid lyrics");
        let syllables = [
            time(2000, 2300),
            time(2300, 2600),
            time(2600, 3200),
            time(3500, 3800),
            time(3800, 4100),
            time(4100, 4400),
            time(4400, 4900),
            time(9900, 10400),
            time(10400, 11000),
        ];
        let countdowns = countdowns(&lyrics, &syllables);
        assert_eq!(dots_swept(&countdowns, 8_650.0), 5.5);
        assert_eq!(dots_swept(&countdowns, 9_900.0), 8.0);
    }

    #[test]
    fn is_zero_for_a_time_that_is_not_a_number_or_negative() {
        let countdowns = one(0, 0);
        assert_eq!(dots_swept(&countdowns, f64::NAN), 0.0);
        assert_eq!(dots_swept(&countdowns, -1.0), 0.0);
        assert_eq!(dots_swept(&countdowns, f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn is_zero_without_countdowns() {
        assert_eq!(dots_swept(&[], 500.0), 0.0);
    }
}
