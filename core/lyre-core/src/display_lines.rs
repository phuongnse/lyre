//! Display lines: how each lyric line is split into lines that fit the
//! screen.
//!
//! The rules are in `docs/domain/knowledge.md`, under "Lyrics". The client
//! measures every syllable, a space and the available width in one unit. The
//! layout only groups syllables: the text itself is only read, never changed
//! (D5).

use std::cmp::Ordering;
use std::fmt;
use std::ops::Range;

use crate::lyrics::Lyrics;
use crate::words::{LineWords, is_punctuation};

/// The shortest silence between two syllables, in milliseconds, that counts
/// as a pause in the singing.
pub const PAUSE_MS: u32 = 180;

/// What the client measured for one syllable: its width on screen and when
/// it is sung.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeasuredSyllable {
    /// The width of the syllable's text.
    pub width: f64,
    /// When the syllable starts, in milliseconds.
    pub start_ms: u32,
    /// When the syllable ends, in milliseconds.
    pub end_ms: u32,
}

/// A line as shown on screen: a run of one lyric line's syllables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayLine {
    /// The index of the lyric line in [`Lyrics::lines`].
    pub lyric_line: usize,
    /// The indices of the syllables shown, within that lyric line.
    pub syllables: Range<usize>,
}

/// Why a layout was refused. No message quotes the lyric text.
#[derive(Debug, Clone, PartialEq)]
pub enum LayoutError {
    /// The client measured `actual` syllables, but the lyrics hold
    /// `expected`.
    SyllableCount { expected: usize, actual: usize },
    /// A width is negative or not a finite number.
    InvalidWidth,
}

impl fmt::Display for LayoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LayoutError::SyllableCount { expected, actual } => write!(
                f,
                "{actual} syllables were measured, but the lyrics hold {expected}"
            ),
            LayoutError::InvalidWidth => write!(f, "a width is negative or not a finite number"),
        }
    }
}

impl std::error::Error for LayoutError {}

/// Lays out every lyric line of `lyrics` as display lines, in order.
///
/// `measured` holds one entry for each syllable of every lyric line, in
/// order. `space_width` is the width of the space between two syllables and
/// `max_width` the width available.
pub fn lay_out(
    lyrics: &Lyrics,
    measured: &[MeasuredSyllable],
    space_width: f64,
    max_width: f64,
) -> Result<Vec<DisplayLine>, LayoutError> {
    let expected: usize = lyrics
        .lines()
        .iter()
        .map(|line| line.syllables().len())
        .sum();
    if measured.len() != expected {
        return Err(LayoutError::SyllableCount {
            expected,
            actual: measured.len(),
        });
    }
    let valid = |width: f64| width.is_finite() && width >= 0.0;
    if !(valid(space_width) && valid(max_width) && measured.iter().all(|m| valid(m.width))) {
        return Err(LayoutError::InvalidWidth);
    }
    let mut display_lines = Vec::new();
    let mut rest = measured;
    for (index, line) in lyrics.lines().iter().enumerate() {
        let (line_measured, after) = rest.split_at(line.syllables().len());
        rest = after;
        let syllables: Vec<&str> = line
            .syllables()
            .iter()
            .map(|syllable| &lyrics.as_str()[syllable.range()])
            .collect();
        display_lines.extend(
            lay_out_line(&syllables, line_measured, space_width, max_width)
                .into_iter()
                .map(|range| DisplayLine {
                    lyric_line: index,
                    syllables: range,
                }),
        );
    }
    Ok(display_lines)
}

/// Lays out one lyric line, given as its syllable texts and their
/// measurements, as ranges of syllable indices.
///
/// The layout has the fewest display lines that fit `max_width`. Among
/// those, it prefers splits at punctuation or pauses, then plain splits, then
/// splits that break a soft rule, then the most even widths. A split never
/// falls inside a listed word. A run that cannot be split stays whole, even
/// when it is wider than `max_width`. [`lay_out`] checks the widths first.
///
/// Panics if `syllables` and `measured` differ in length.
pub fn lay_out_line(
    syllables: &[&str],
    measured: &[MeasuredSyllable],
    space_width: f64,
    max_width: f64,
) -> Vec<Range<usize>> {
    assert_eq!(
        syllables.len(),
        measured.len(),
        "every syllable needs one measurement"
    );
    let n = syllables.len();
    if n == 0 {
        return Vec::new();
    }
    let gaps = classify_gaps(syllables, measured);
    // `best[j]` is the cheapest layout of syllables `0..j` whose last display
    // line ends at `j`, with the start of that last display line.
    let mut best: Vec<Option<(Cost, usize)>> = vec![None; n + 1];
    best[0] = Some((Cost::default(), 0));
    for i in 0..n {
        let Some((base, _)) = best[i] else {
            continue;
        };
        let mut width = 0.0;
        let mut splittable = false;
        for j in i + 1..=n {
            if j > i + 1 {
                width += space_width;
                splittable |= gaps[j - 2] != Gap::InsideWord;
            }
            width += measured[j - 1].width;
            // Every longer run from `i` is at least as wide and can be split
            // too, so none of them is allowed either.
            if width > max_width && splittable {
                break;
            }
            let split = if j < n { Some(gaps[j - 1]) } else { None };
            if split == Some(Gap::InsideWord) {
                continue;
            }
            let cost = base.with_line(width, max_width, split);
            if best[j].is_none_or(|(known, _)| cost.compare(&known) == Ordering::Less) {
                best[j] = Some((cost, i));
            }
        }
    }
    let mut ranges = Vec::new();
    let mut end = n;
    while end > 0 {
        let (_, start) = best[end].expect("every end on the chosen path is reachable");
        ranges.push(start..end);
        end = start;
    }
    ranges.reverse();
    ranges
}

/// What a split between two neighbouring syllables would mean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gap {
    /// Inside a listed word: never split here.
    InsideWord,
    /// At the owner's punctuation or a pause in the singing.
    Strong,
    /// Ends a display line on a linking word or starts one with a trailing
    /// modifier.
    Soft,
    /// Anywhere else.
    Plain,
}

/// Classifies each gap of a line. Gap `k` lies between syllable `k` and
/// syllable `k + 1`.
fn classify_gaps(syllables: &[&str], measured: &[MeasuredSyllable]) -> Vec<Gap> {
    let words = LineWords::find(syllables);
    (0..words.gap_count())
        .map(|k| {
            let pause = measured[k + 1].start_ms.saturating_sub(measured[k].end_ms) >= PAUSE_MS;
            let punctuation = syllables[k].chars().next_back().is_some_and(is_punctuation)
                || syllables[k + 1].chars().next().is_some_and(is_punctuation);
            if words.gap_inside_word(k) {
                Gap::InsideWord
            } else if pause || punctuation {
                Gap::Strong
            } else if words.is_linking_word(k) || words.is_trailing_modifier(k + 1) {
                Gap::Soft
            } else {
                Gap::Plain
            }
        })
        .collect()
}

/// The cost of a layout, compared field by field in order.
#[derive(Debug, Clone, Copy, Default)]
struct Cost {
    display_lines: usize,
    soft_splits: usize,
    plain_splits: usize,
    /// The sum of each display line's squared unused width.
    raggedness: f64,
}

impl Cost {
    /// This cost with one more display line of `width`, ended by `split`, or
    /// by the end of the lyric line when `split` is `None`.
    fn with_line(self, width: f64, max_width: f64, split: Option<Gap>) -> Cost {
        Cost {
            display_lines: self.display_lines + 1,
            soft_splits: self.soft_splits + usize::from(split == Some(Gap::Soft)),
            plain_splits: self.plain_splits + usize::from(split == Some(Gap::Plain)),
            raggedness: self.raggedness + (max_width - width).max(0.0).powi(2),
        }
    }

    fn compare(&self, other: &Cost) -> Ordering {
        self.display_lines
            .cmp(&other.display_lines)
            .then(self.soft_splits.cmp(&other.soft_splits))
            .then(self.plain_splits.cmp(&other.plain_splits))
            .then(self.raggedness.total_cmp(&other.raggedness))
    }
}

#[cfg(test)]
// Expected layouts are lists of ranges, and a layout may hold one range.
#[allow(clippy::single_range_in_vec_init)]
mod tests {
    use super::*;

    /// Each syllable 10 wide and 300 ms long, sung with no pause between.
    fn measure(count: usize) -> Vec<MeasuredSyllable> {
        (0..count)
            .map(|i| {
                let start = i as u32 * 300;
                MeasuredSyllable {
                    width: 10.0,
                    start_ms: start,
                    end_ms: start + 300,
                }
            })
            .collect()
    }

    /// Like [`measure`], with every syllable after gap `gap` shifted `ms`
    /// later.
    fn measure_with_pause(count: usize, gap: usize, ms: u32) -> Vec<MeasuredSyllable> {
        let mut measured = measure(count);
        for syllable in &mut measured[gap + 1..] {
            syllable.start_ms += ms;
            syllable.end_ms += ms;
        }
        measured
    }

    /// The display lines of `line`, split on spaces, as text.
    fn lines_of(line: &str, measured: &[MeasuredSyllable], max_width: f64) -> Vec<String> {
        let syllables: Vec<&str> = line.split(' ').collect();
        lay_out_line(&syllables, measured, 2.0, max_width)
            .into_iter()
            .map(|range| syllables[range].join(" "))
            .collect()
    }

    fn plain(line: &str, max_width: f64) -> Vec<String> {
        lines_of(line, &measure(line.split(' ').count()), max_width)
    }

    #[test]
    fn prefers_a_plain_split_to_one_after_a_linking_word() {
        assert_eq!(
            plain("những kỷ niệm và nụ cười xưa", 50.0),
            ["những kỷ niệm", "và nụ cười xưa"]
        );
    }

    #[test]
    fn prefers_even_widths_and_keeps_words_and_trailing_modifiers() {
        assert_eq!(
            plain("anh nhớ nụ cười xưa", 50.0),
            ["anh nhớ", "nụ cười xưa"]
        );
    }

    #[test]
    fn splits_at_punctuation_before_anywhere_else() {
        assert_eq!(
            plain("chiều nay em về, bên sông", 46.0),
            ["chiều nay em về,", "bên sông"]
        );
    }

    #[test]
    fn splits_at_a_pause_of_180_ms() {
        let line = "chiều nay em về bên sông";
        assert_eq!(
            lines_of(line, &measure_with_pause(6, 3, PAUSE_MS), 46.0),
            ["chiều nay em về", "bên sông"]
        );
    }

    #[test]
    fn a_pause_of_179_ms_is_a_plain_gap() {
        let line = "chiều nay em về bên sông";
        assert_eq!(
            lines_of(line, &measure_with_pause(6, 3, PAUSE_MS - 1), 46.0),
            ["chiều nay em", "về bên sông"]
        );
    }

    #[test]
    fn a_line_that_fits_stays_whole() {
        let line = "chiều nay em về, bên sông";
        // 6 syllables of 10 and 5 spaces of 2.
        assert_eq!(lines_of(line, &measure_with_pause(6, 1, 400), 70.0), [line]);
    }

    #[test]
    fn a_word_too_wide_for_the_screen_stays_whole() {
        assert_eq!(plain("kỷ niệm", 15.0), ["kỷ niệm"]);
    }

    #[test]
    fn punctuation_on_the_next_syllable_is_a_strong_split() {
        assert_eq!(
            plain("chiều nay em về (bên sông)", 46.0),
            ["chiều nay em về", "(bên sông)"]
        );
        // A dash on its own makes both of its gaps strong. The even split
        // picks the one before it.
        assert_eq!(
            plain("chiều nay em – về bên", 46.0),
            ["chiều nay em", "– về bên"]
        );
    }

    #[test]
    fn an_empty_line_has_no_display_lines() {
        assert_eq!(
            lay_out_line(&[], &[], 2.0, 50.0),
            Vec::<Range<usize>>::new()
        );
    }

    #[test]
    fn lays_out_every_lyric_line_and_keeps_the_lyrics() {
        let input = "anh nhớ nụ cười xưa\r\n\r\nem về\nkỷ niệm\n";
        let lyrics = Lyrics::parse(input.as_bytes()).expect("lyrics are accepted");
        let lines = lay_out(&lyrics, &measure(9), 2.0, 50.0).expect("layout succeeds");
        assert_eq!(
            lines,
            [
                DisplayLine {
                    lyric_line: 0,
                    syllables: 0..2
                },
                DisplayLine {
                    lyric_line: 0,
                    syllables: 2..5
                },
                DisplayLine {
                    lyric_line: 1,
                    syllables: 0..2
                },
                DisplayLine {
                    lyric_line: 2,
                    syllables: 0..2
                },
            ]
        );
        assert_eq!(lyrics.lines().len(), 3);
        assert_eq!(lyrics.as_bytes(), input.as_bytes());
    }

    #[test]
    fn refuses_a_wrong_number_of_measurements() {
        let lyrics = Lyrics::parse("em về\nbên sông".as_bytes()).expect("lyrics are accepted");
        assert_eq!(
            lay_out(&lyrics, &measure(3), 2.0, 50.0),
            Err(LayoutError::SyllableCount {
                expected: 4,
                actual: 3
            })
        );
        assert_eq!(
            lay_out(&lyrics, &measure(5), 2.0, 50.0),
            Err(LayoutError::SyllableCount {
                expected: 4,
                actual: 5
            })
        );
    }

    #[test]
    fn refuses_a_negative_or_non_finite_width() {
        let lyrics = Lyrics::parse("em về".as_bytes()).expect("lyrics are accepted");
        for bad in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut measured = measure(2);
            measured[1].width = bad;
            assert_eq!(
                lay_out(&lyrics, &measured, 2.0, 50.0),
                Err(LayoutError::InvalidWidth)
            );
            assert_eq!(
                lay_out(&lyrics, &measure(2), bad, 50.0),
                Err(LayoutError::InvalidWidth)
            );
            assert_eq!(
                lay_out(&lyrics, &measure(2), 2.0, bad),
                Err(LayoutError::InvalidWidth)
            );
        }
        assert!(lay_out(&lyrics, &measure(2), 0.0, 0.0).is_ok());
    }

    #[test]
    fn error_messages_do_not_quote_the_lyrics() {
        let message = LayoutError::SyllableCount {
            expected: 4,
            actual: 3,
        }
        .to_string();
        assert_eq!(message, "3 syllables were measured, but the lyrics hold 4");
    }

    /// A small seeded xorshift generator, so the random cases repeat.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    /// Syllables that mix listed words, soft-rule words, punctuation and
    /// plain syllables.
    const VOCABULARY: [&str; 18] = [
        "kỷ", "niệm", "nụ", "cười", "một", "mình", "và", "của", "những", "xưa", "này", "về,",
        "(bên", "sông)", "em", "anh", "nhớ", "–",
    ];

    /// The width of syllables `range`, summed in the same order as the
    /// layout sums it.
    fn width_of(measured: &[MeasuredSyllable], range: Range<usize>, space_width: f64) -> f64 {
        let mut width = 0.0;
        for k in range.clone() {
            if k > range.start {
                width += space_width;
            }
            width += measured[k].width;
        }
        width
    }

    /// The cheapest cost of any allowed layout, by trying every set of
    /// splits.
    fn cheapest_cost(
        gaps: &[Gap],
        measured: &[MeasuredSyllable],
        space_width: f64,
        max_width: f64,
    ) -> Cost {
        let n = measured.len();
        let mut cheapest: Option<Cost> = None;
        'masks: for mask in 0u32..1 << gaps.len() {
            let mut cost = Cost::default();
            let mut start = 0;
            for end in 1..=n {
                let split = end < n && mask & (1 << (end - 1)) != 0;
                if end < n && !split {
                    continue;
                }
                let gap = (end < n).then(|| gaps[end - 1]);
                if gap == Some(Gap::InsideWord) {
                    continue 'masks;
                }
                let width = width_of(measured, start..end, space_width);
                let splittable = (start..end - 1).any(|k| gaps[k] != Gap::InsideWord);
                if width > max_width && splittable {
                    continue 'masks;
                }
                cost = cost.with_line(width, max_width, gap);
                start = end;
            }
            if cheapest.is_none_or(|known| cost.compare(&known) == Ordering::Less) {
                cheapest = Some(cost);
            }
        }
        cheapest.expect("a layout without splits inside words always exists")
    }

    #[test]
    fn random_lyrics_keep_their_syllables_and_words() {
        let mut rng = Rng(0x5eed_1a7e_u64);
        let space_width = 2.0;
        for case in 0..1_000 {
            // Lyrics need a letter, so each line starts with "anh".
            let lyric_lines: Vec<String> = (0..1 + rng.below(4))
                .map(|_| {
                    let rest = (0..rng.below(10))
                        .map(|_| VOCABULARY[rng.below(VOCABULARY.len() as u64) as usize]);
                    std::iter::once("anh")
                        .chain(rest)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect();
            let input = lyric_lines.join("\n");
            let lyrics = Lyrics::parse(input.as_bytes()).expect("lyrics are accepted");
            let total: usize = lyrics.lines().iter().map(|l| l.syllables().len()).sum();
            let mut time = 0;
            let measured: Vec<MeasuredSyllable> = (0..total)
                .map(|_| {
                    let start = time + rng.below(401) as u32;
                    let end = start + 50 + rng.below(451) as u32;
                    time = end;
                    MeasuredSyllable {
                        width: rng.below(3_001) as f64 / 100.0,
                        start_ms: start,
                        end_ms: end,
                    }
                })
                .collect();
            let max_width = rng.below(12_001) as f64 / 100.0;
            let display_lines =
                lay_out(&lyrics, &measured, space_width, max_width).expect("layout succeeds");

            let mut rest = &measured[..];
            let mut next = 0;
            for (index, line) in lyrics.lines().iter().enumerate() {
                let (line_measured, after) = rest.split_at(line.syllables().len());
                rest = after;
                let syllables: Vec<&str> = line
                    .syllables()
                    .iter()
                    .map(|syllable| &lyrics.as_str()[syllable.range()])
                    .collect();
                let gaps = classify_gaps(&syllables, line_measured);
                let words = LineWords::find(&syllables);
                let mut covered = 0;
                let mut cost = Cost::default();
                while next < display_lines.len() && display_lines[next].lyric_line == index {
                    let range = display_lines[next].syllables.clone();
                    next += 1;
                    assert_eq!(range.start, covered, "case {case}");
                    assert!(range.end > range.start, "case {case}");
                    if range.end < syllables.len() {
                        assert!(!words.gap_inside_word(range.end - 1), "case {case}");
                    }
                    let width = width_of(line_measured, range.clone(), space_width);
                    let splittable =
                        (range.start..range.end - 1).any(|k| !words.gap_inside_word(k));
                    assert!(width <= max_width || !splittable, "case {case}");
                    let split = (range.end < syllables.len()).then(|| gaps[range.end - 1]);
                    cost = cost.with_line(width, max_width, split);
                    covered = range.end;
                }
                assert_eq!(covered, syllables.len(), "case {case}");
                let cheapest = cheapest_cost(&gaps, line_measured, space_width, max_width);
                assert_eq!(cost.compare(&cheapest), Ordering::Equal, "case {case}");
            }
            assert_eq!(next, display_lines.len(), "case {case}");
            assert_eq!(lyrics.as_bytes(), input.as_bytes());
        }
    }
}
