//! Vietnamese words in a lyric line: which gaps between neighbouring
//! syllables fall inside a listed multi-syllable word, and which syllables
//! are linking words or trailing modifiers.
//!
//! The rules are in `docs/decisions.md`, under D18. The lists are the short
//! ones written for Lyre, kept in `src/words/`. Matching builds an internal
//! key from each syllable that ignores case, Unicode normal form, old or new
//! tone placement and punctuation around a word. The lyric text itself is
//! only read, never changed (D5).

use std::collections::HashSet;
use std::sync::OnceLock;

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::lyrics::{LyricLine, Lyrics};

/// Multi-syllable words written for Lyre, one per line.
const MULTI_SYLLABLE_WORDS: &str = include_str!("words/multi_syllable_words.txt");

/// Linking words a display line should not end on, one per line.
const LINKING_WORDS: &str = include_str!("words/linking_words.txt");

/// Trailing modifiers a display line should not start with, one per line.
const TRAILING_MODIFIERS: &str = include_str!("words/trailing_modifiers.txt");

/// The Vietnamese tone marks, as combining characters: grave, acute, tilde,
/// hook above and dot below.
const TONE_MARKS: [char; 5] = ['\u{0300}', '\u{0301}', '\u{0303}', '\u{0309}', '\u{0323}'];

/// What the finder knows about the words of one lyric line.
///
/// Gap `k` lies between syllable `k` and syllable `k + 1`, so a line of `n`
/// syllables has `n - 1` gaps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineWords {
    inside_word: Vec<bool>,
    linking: Vec<bool>,
    trailing: Vec<bool>,
}

impl LineWords {
    /// Finds the words of a line given as its syllable texts, in order.
    ///
    /// A gap is inside a word when a listed multi-syllable word covers the
    /// syllables on both sides. When listed words overlap, every gap they
    /// cover is inside a word.
    pub fn find(syllables: &[&str]) -> LineWords {
        let lists = lists();
        let parts: Vec<Part> = syllables
            .iter()
            .map(|syllable| Part::new(syllable))
            .collect();
        let mut inside_word = vec![false; parts.len().saturating_sub(1)];
        for start in 0..parts.len() {
            for len in 2..=lists.max_syllables {
                let end = start + len;
                if end > parts.len() {
                    break;
                }
                let span = &parts[start..end];
                // A longer span from the same start holds the same syllables
                // in the same inner places, so it cannot match either.
                let broken = span.iter().any(|part| part.key.is_none())
                    || span[..len - 1].iter().any(|part| part.trailing_punct)
                    || span[1..].iter().any(|part| part.leading_punct);
                if broken {
                    break;
                }
                let key = span
                    .iter()
                    .filter_map(|part| part.key.as_deref())
                    .collect::<Vec<_>>()
                    .join(" ");
                if lists.multi_syllable.contains(&key) {
                    inside_word[start..end - 1].fill(true);
                }
            }
        }
        let is_in = |set: &HashSet<String>, part: &Part| {
            part.key.as_ref().is_some_and(|key| set.contains(key))
        };
        LineWords {
            inside_word,
            linking: parts
                .iter()
                .map(|part| is_in(&lists.linking, part))
                .collect(),
            trailing: parts
                .iter()
                .map(|part| is_in(&lists.trailing, part))
                .collect(),
        }
    }

    /// Finds the words of `line`, reading its syllables from `lyrics`.
    pub fn of_line(lyrics: &Lyrics, line: &LyricLine) -> LineWords {
        let syllables: Vec<&str> = line
            .syllables()
            .iter()
            .map(|syllable| &lyrics.as_str()[syllable.range()])
            .collect();
        LineWords::find(&syllables)
    }

    /// The number of gaps between neighbouring syllables.
    pub fn gap_count(&self) -> usize {
        self.inside_word.len()
    }

    /// Whether gap `gap` lies inside a listed multi-syllable word.
    ///
    /// Panics if `gap` is not less than [`LineWords::gap_count`].
    pub fn gap_inside_word(&self, gap: usize) -> bool {
        self.inside_word[gap]
    }

    /// Whether syllable `syllable` is a linking word, such as "và".
    ///
    /// Panics if `syllable` is not a syllable of the line.
    pub fn is_linking_word(&self, syllable: usize) -> bool {
        self.linking[syllable]
    }

    /// Whether syllable `syllable` is a trailing modifier, such as "xưa".
    ///
    /// Panics if `syllable` is not a syllable of the line.
    pub fn is_trailing_modifier(&self, syllable: usize) -> bool {
        self.trailing[syllable]
    }
}

/// One syllable as the finder sees it.
struct Part {
    /// The matching key of the syllable without its outer punctuation, or
    /// `None` when nothing is left.
    key: Option<String>,
    /// Whether punctuation was trimmed from the start.
    leading_punct: bool,
    /// Whether punctuation was trimmed from the end.
    trailing_punct: bool,
}

impl Part {
    fn new(syllable: &str) -> Part {
        let is_punct = |c: char| !(c.is_alphanumeric() || is_combining_mark(c));
        let after_start = syllable.trim_start_matches(is_punct);
        let core = after_start.trim_end_matches(is_punct);
        Part {
            key: (!core.is_empty()).then(|| syllable_key(core)),
            leading_punct: after_start.len() < syllable.len(),
            trailing_punct: core.len() < after_start.len(),
        }
    }
}

/// The matching key of one syllable: lowercase and NFC, with its tone marks
/// moved off their vowel to the end, so old and new tone placement give the
/// same key.
fn syllable_key(core: &str) -> String {
    let mut tones = Vec::new();
    let toneless: String = core
        .to_lowercase()
        .nfd()
        .filter(|&c| {
            let is_tone = TONE_MARKS.contains(&c);
            if is_tone {
                tones.push(c);
            }
            !is_tone
        })
        .collect();
    let mut key: String = toneless.nfc().collect();
    key.extend(tones);
    key
}

/// The parsed lists the finder matches against, built once.
struct Lists {
    multi_syllable: HashSet<String>,
    max_syllables: usize,
    linking: HashSet<String>,
    trailing: HashSet<String>,
}

fn lists() -> &'static Lists {
    static LISTS: OnceLock<Lists> = OnceLock::new();
    LISTS.get_or_init(|| {
        let multi = entries(MULTI_SYLLABLE_WORDS);
        Lists {
            max_syllables: multi.iter().map(|entry| entry.syllables).max().unwrap_or(0),
            multi_syllable: multi.into_iter().map(|entry| entry.key).collect(),
            linking: entries(LINKING_WORDS)
                .into_iter()
                .map(|entry| entry.key)
                .collect(),
            trailing: entries(TRAILING_MODIFIERS)
                .into_iter()
                .map(|entry| entry.key)
                .collect(),
        }
    })
}

/// One entry of a word list.
struct Entry {
    /// The syllable keys joined with one space.
    key: String,
    /// The number of syllables.
    syllables: usize,
}

/// The entries of a list file: one per line, blank lines ignored.
fn entries(data: &str) -> Vec<Entry> {
    data.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let keys: Vec<String> = line.split_whitespace().map(syllable_key).collect();
            Entry {
                syllables: keys.len(),
                key: keys.join(" "),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gaps of `line`, split on spaces, that lie inside a word.
    fn gaps_inside(line: &str) -> Vec<usize> {
        let syllables: Vec<&str> = line.split(' ').collect();
        let words = LineWords::find(&syllables);
        (0..words.gap_count())
            .filter(|&gap| words.gap_inside_word(gap))
            .collect()
    }

    #[test]
    fn finds_only_the_listed_words_of_a_line() {
        // những | kỷ niệm | và | nụ cười
        assert_eq!(gaps_inside("những kỷ niệm và nụ cười"), vec![1, 4]);
    }

    #[test]
    fn ignores_tone_placement_normal_form_case_and_outer_punctuation() {
        let nfd: String = "kỷ niệm".nfd().collect();
        assert_ne!(nfd, "kỷ niệm");
        for line in [
            "hoà bình",
            "hòa bình",
            &nfd,
            "KỶ NIỆM",
            "kỷ niệm,",
            "(Kỷ niệm)",
        ] {
            assert_eq!(gaps_inside(line), vec![0], "{line:?}");
        }
    }

    #[test]
    fn folds_tone_placement_in_nfd_text() {
        let old: String = "thuỷ".nfd().collect();
        assert_eq!(syllable_key(&old), syllable_key("thủy"));
        assert_eq!(syllable_key("hoà"), syllable_key("hòa"));
        assert_ne!(syllable_key("hoà"), syllable_key("hoá"));
    }

    #[test]
    fn punctuation_between_syllables_stops_a_match() {
        assert_eq!(gaps_inside("kỷ, niệm"), Vec::<usize>::new());
        assert_eq!(gaps_inside("kỷ ,niệm"), Vec::<usize>::new());
        assert_eq!(gaps_inside("kỷ - niệm"), Vec::<usize>::new());
    }

    #[test]
    fn reports_linking_words_and_trailing_modifiers() {
        let syllables = ["và", "của", "những", "một", "xưa", "này", "ấy", "cửa", "em"];
        let words = LineWords::find(&syllables);
        let linking: Vec<bool> = (0..syllables.len())
            .map(|syllable| words.is_linking_word(syllable))
            .collect();
        let trailing: Vec<bool> = (0..syllables.len())
            .map(|syllable| words.is_trailing_modifier(syllable))
            .collect();
        assert_eq!(
            linking,
            [true, true, true, true, false, false, false, false, false]
        );
        assert_eq!(
            trailing,
            [false, false, false, false, true, true, true, false, false]
        );
    }

    #[test]
    fn soft_lists_ignore_case_and_outer_punctuation() {
        let words = LineWords::find(&["Và", "NÀY,", "…"]);
        assert!(words.is_linking_word(0));
        assert!(words.is_trailing_modifier(1));
        assert!(!words.is_linking_word(2));
        assert!(!words.is_trailing_modifier(2));
    }

    #[test]
    fn overlapping_words_cover_every_gap() {
        assert_eq!(gaps_inside("học sinh viên"), vec![0, 1]);
    }

    #[test]
    fn a_short_line_has_no_gaps() {
        assert_eq!(LineWords::find(&[]).gap_count(), 0);
        assert_eq!(LineWords::find(&["em"]).gap_count(), 0);
    }

    #[test]
    fn keeps_the_lyrics_unchanged() {
        let input = "Hoà bình  KỶ NIỆM,\r\nnhững nụ cười xưa\n";
        let lyrics = Lyrics::parse(input.as_bytes()).expect("lyrics are accepted");
        let found: Vec<LineWords> = lyrics
            .lines()
            .iter()
            .map(|line| LineWords::of_line(&lyrics, line))
            .collect();
        assert!(found[0].gap_inside_word(0));
        assert!(!found[0].gap_inside_word(1));
        assert!(found[0].gap_inside_word(2));
        assert!(found[1].gap_inside_word(1));
        assert!(found[1].is_trailing_modifier(3));
        assert_eq!(lyrics.as_bytes(), input.as_bytes());
    }

    #[test]
    fn multi_syllable_entries_have_at_least_two_syllables() {
        for entry in entries(MULTI_SYLLABLE_WORDS) {
            assert!(entry.syllables >= 2, "{:?}", entry.key);
        }
    }

    #[test]
    fn linking_and_trailing_entries_have_one_syllable() {
        for data in [LINKING_WORDS, TRAILING_MODIFIERS] {
            for entry in entries(data) {
                assert_eq!(entry.syllables, 1, "{:?}", entry.key);
            }
        }
    }

    #[test]
    fn lists_hold_no_duplicate_keys() {
        for data in [MULTI_SYLLABLE_WORDS, LINKING_WORDS, TRAILING_MODIFIERS] {
            let keys: Vec<String> = entries(data).into_iter().map(|entry| entry.key).collect();
            let unique: HashSet<&String> = keys.iter().collect();
            assert_eq!(unique.len(), keys.len());
        }
    }
}
