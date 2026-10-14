//! The Lyrics area's two rows: which display line each row shows at a media
//! time.
//!
//! The rules are in `docs/ui-conventions.md`, under "Lyrics area". Both
//! clients call this, so the rows are the same on the web and on Android.
//! The text itself is never read (D5).

use crate::countdown::Countdown;
use crate::display_lines::DisplayLine;
use crate::lyrics::Lyrics;
use crate::song_file::SyllableTime;

/// How long before its first syllable a group shows: 2 s of countdown dots
/// and 2 s to read.
pub const LEAD_MS: u32 = 4_000;

/// The display lines the two rows show. Each is a position in the list of
/// display lines, or `None` for an empty row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rows {
    pub top: Option<usize>,
    pub bottom: Option<usize>,
}

/// Which display line each row shows at `ms`.
///
/// `display_lines` is the core's layout of `lyrics`. `syllables` are the
/// times of every syllable, in order, and `countdowns` the lyric lines with
/// countdown dots. A display line that has no times never starts or ends. A
/// time that is not a number, or is negative, is read as 0.
pub fn rows(
    lyrics: &Lyrics,
    syllables: &[SyllableTime],
    countdowns: &[Countdown],
    display_lines: &[DisplayLine],
    ms: f64,
) -> Rows {
    let ms = if ms.is_nan() || ms < 0.0 { 0.0 } else { ms };
    if display_lines.is_empty() {
        return Rows::default();
    }
    // The index of each lyric line's first syllable.
    let mut first = Vec::with_capacity(lyrics.lines().len());
    let mut count = 0;
    for line in lyrics.lines() {
        first.push(count);
        count += line.syllables().len();
    }
    let time = |line: &DisplayLine, end: bool| {
        let Some(&offset) = first.get(line.lyric_line) else {
            return u32::MAX;
        };
        let index = if end {
            line.syllables.end.checked_sub(1)
        } else {
            Some(line.syllables.start)
        };
        index
            .and_then(|index| syllables.get(offset + index))
            .map_or(
                u32::MAX,
                |time| if end { time.end_ms } else { time.start_ms },
            )
    };
    let starts = |line: &DisplayLine| time(line, false);
    let ends = |line: &DisplayLine| time(line, true);

    // The groups, as ranges of display lines. A group starts at the first
    // display line of each lyric line with countdown dots.
    let mut group_starts = vec![0];
    for (index, line) in display_lines.iter().enumerate().skip(1) {
        let counts_down = countdowns
            .iter()
            .any(|countdown| countdown.lyric_line == line.lyric_line);
        if line.syllables.start == 0 && counts_down {
            group_starts.push(index);
        }
    }
    group_starts.push(display_lines.len());

    // A group shows at the later of LEAD_MS before its first syllable and the
    // end of the group before it. The first group has none before it, so it
    // shows at LEAD_MS before its first syllable, or at 0 if that is earlier.
    // Until a group shows, both rows are empty. A group stays up until its
    // last line ends, and the last group stays up for good.
    let groups = group_starts.len() - 1;
    let group_lines = |group: usize| &display_lines[group_starts[group]..group_starts[group + 1]];
    let shows_at = |group: usize| {
        let first_start = group_lines(group).first().map_or(u32::MAX, starts);
        let previous_end = match group.checked_sub(1) {
            Some(previous) => group_lines(previous).last().map_or(u32::MAX, ends),
            None => 0,
        };
        first_start.saturating_sub(LEAD_MS).max(previous_end)
    };
    let Some(group) = (0..groups)
        .rev()
        .find(|&group| ms >= f64::from(shows_at(group)))
    else {
        return Rows::default();
    };
    let lines = group_lines(group);
    let last_end = lines.last().map_or(u32::MAX, ends);
    if group + 1 < groups && ms >= f64::from(last_end) {
        return Rows::default();
    }
    let offset = group_starts[group];

    // A row moves two lines on when the line in the other row starts.
    let row = |row: usize| {
        if row >= lines.len() {
            return None;
        }
        let mut k = row;
        while k + 2 < lines.len() && ms >= f64::from(starts(&lines[k + 1])) {
            k += 2;
        }
        Some(offset + k)
    };
    Rows {
        top: row(0),
        bottom: row(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::countdown::countdowns;

    fn times(list: &[(u32, u32)]) -> Vec<SyllableTime> {
        list.iter()
            .map(|&(start_ms, end_ms)| SyllableTime { start_ms, end_ms })
            .collect()
    }

    /// One display line for each lyric line, holding all its syllables.
    fn whole_lines(lyrics: &Lyrics) -> Vec<DisplayLine> {
        lyrics
            .lines()
            .iter()
            .enumerate()
            .map(|(lyric_line, line)| DisplayLine {
                lyric_line,
                syllables: 0..line.syllables().len(),
            })
            .collect()
    }

    fn rows_at(
        lyrics: &Lyrics,
        syllables: &[SyllableTime],
        display_lines: &[DisplayLine],
        ms: f64,
    ) -> [Option<usize>; 2] {
        let countdowns = countdowns(lyrics, syllables);
        let result = rows(lyrics, syllables, &countdowns, display_lines, ms);
        [result.top, result.bottom]
    }

    #[test]
    fn the_fixture_song_shows_its_two_groups() {
        let lyrics = Lyrics::parse("Mưa rơi nhẹ\n\nEm về bên sông\n\nTrăng lên".as_bytes())
            .expect("valid lyrics");
        let syllables = times(&[
            (2000, 2300),
            (2300, 2600),
            (2600, 3200),
            (3500, 3800),
            (3800, 4100),
            (4100, 4400),
            (4400, 4900),
            (9900, 10400),
            (10400, 11000),
        ]);
        let display_lines = whole_lines(&lyrics);
        assert_eq!(display_lines.len(), 3);
        for ms in [0.0, 1000.0, 3300.0, 4000.0] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [Some(0), Some(1)],
                "at {ms} ms"
            );
        }
        for ms in [4900.0, 5000.0, 5899.0] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [None, None],
                "at {ms} ms"
            );
        }
        for ms in [5900.0, 6000.0, 11500.0] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [Some(2), None],
                "at {ms} ms"
            );
        }
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 4899.0),
            [Some(0), Some(1)]
        );
    }

    #[test]
    fn a_group_shows_at_most_the_lead_before_its_first_syllable() {
        let lyrics = Lyrics::parse(b"a").expect("valid lyrics");
        let syllables = times(&[(30000, 30500)]);
        let display_lines = whole_lines(&lyrics);
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 25900.0),
            [None, None]
        );
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 26000.0),
            [Some(0), None]
        );
    }

    #[test]
    fn after_a_long_break_a_group_shows_the_lead_before_its_first_syllable() {
        let lyrics = Lyrics::parse(b"a\nb").expect("valid lyrics");
        let syllables = times(&[(0, 1000), (21000, 21500)]);
        let display_lines = whole_lines(&lyrics);
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 2000.0),
            [None, None]
        );
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 16999.0),
            [None, None]
        );
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 17000.0),
            [Some(1), None]
        );
    }

    #[test]
    fn a_group_that_follows_closely_shows_when_the_group_before_ends() {
        let lyrics = Lyrics::parse(b"a\nb").expect("valid lyrics");
        let syllables = times(&[(0, 1000), (3000, 3500)]);
        let display_lines = whole_lines(&lyrics);
        let countdowns = [Countdown {
            lyric_line: 1,
            from_ms: 1000,
            to_ms: 3000,
        }];
        for (ms, expected) in [(999.0, [Some(0), None]), (1000.0, [Some(1), None])] {
            let result = rows(&lyrics, &syllables, &countdowns, &display_lines, ms);
            assert_eq!([result.top, result.bottom], expected, "at {ms} ms");
        }
    }

    #[test]
    fn a_first_syllable_within_the_lead_shows_the_first_group_from_zero() {
        let lyrics = Lyrics::parse(b"a").expect("valid lyrics");
        let syllables = times(&[(3000, 3500)]);
        let display_lines = whole_lines(&lyrics);
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 0.0),
            [Some(0), None]
        );
    }

    #[test]
    fn a_row_moves_on_when_the_line_in_the_other_row_starts() {
        let lyrics = Lyrics::parse(b"a\nb\nc\nd").expect("valid lyrics");
        let syllables = times(&[(0, 1000), (1500, 2500), (3000, 4000), (4500, 5500)]);
        let display_lines = whole_lines(&lyrics);
        let cases = [
            (500.0, [0, 1]),
            (1200.0, [0, 1]),
            (1499.0, [0, 1]),
            (1500.0, [2, 1]),
            (2700.0, [2, 1]),
            (2999.0, [2, 1]),
            (3000.0, [2, 3]),
            (5000.0, [2, 3]),
            (9000.0, [2, 3]),
        ];
        for (ms, [top, bottom]) in cases {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [Some(top), Some(bottom)],
                "at {ms} ms"
            );
        }
    }

    #[test]
    fn the_second_display_line_of_a_lyric_line_is_in_the_bottom_row() {
        let lyrics = Lyrics::parse(b"a b c d").expect("valid lyrics");
        let syllables = times(&[(0, 500), (500, 1000), (1000, 1500), (1500, 2000)]);
        let display_lines = vec![
            DisplayLine {
                lyric_line: 0,
                syllables: 0..2,
            },
            DisplayLine {
                lyric_line: 0,
                syllables: 2..4,
            },
        ];
        for ms in [0.0, 1200.0, 5000.0] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [Some(0), Some(1)],
                "at {ms} ms"
            );
        }
    }

    #[test]
    fn a_time_that_is_not_a_number_or_negative_gives_the_opening_rows() {
        let lyrics = Lyrics::parse(b"a\nb\nc").expect("valid lyrics");
        let syllables = times(&[(0, 1000), (1500, 2500), (3000, 4000)]);
        let display_lines = whole_lines(&lyrics);
        for ms in [f64::NAN, -1.0, f64::NEG_INFINITY] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [Some(0), Some(1)]
            );
        }
    }

    #[test]
    fn a_time_that_is_not_a_number_or_negative_is_read_as_zero() {
        let lyrics = Lyrics::parse(b"a\nb").expect("valid lyrics");
        let syllables = times(&[(30000, 30500), (31000, 31500)]);
        let display_lines = whole_lines(&lyrics);
        for ms in [f64::NAN, -1.0] {
            assert_eq!(
                rows_at(&lyrics, &syllables, &display_lines, ms),
                [None, None]
            );
        }
    }

    #[test]
    fn no_display_lines_give_empty_rows() {
        let lyrics = Lyrics::parse(b"a").expect("valid lyrics");
        let syllables = times(&[(0, 1000)]);
        assert_eq!(rows_at(&lyrics, &syllables, &[], 500.0), [None, None]);
    }

    #[test]
    fn a_single_line_group_has_an_empty_bottom_row() {
        let lyrics = Lyrics::parse(b"a").expect("valid lyrics");
        let syllables = times(&[(0, 1000)]);
        let display_lines = whole_lines(&lyrics);
        assert_eq!(
            rows_at(&lyrics, &syllables, &display_lines, 500.0),
            [Some(0), None]
        );
    }
}
