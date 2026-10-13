//! Forced alignment: when each supplied syllable is sung, worked out from a
//! CTC model's output for the whole song.
//!
//! The rules are in `docs/domain/knowledge.md`, under "Processing". The
//! aligner only times the syllables of the lyrics and never recognises words
//! (D5, D15). Each syllable is matched to the model's vocabulary through a
//! folded copy. The lyric bytes never change.

use std::collections::HashMap;
use std::fmt;
use std::ops::RangeInclusive;

use unicode_normalization::UnicodeNormalization;

use crate::lyrics::Lyrics;
use crate::song_file::{self, SyllableTime, Timing};

/// The most frames accepted: one hour (`MAX_SONG_MS`) at 20 ms a frame.
pub const MAX_FRAMES: usize = 180_000;
/// The most vocabulary entries accepted, counting the blank token.
pub const MAX_VOCABULARY: usize = 16_384;
/// The longest vocabulary entry accepted, in bytes.
pub const MAX_TOKEN_BYTES: usize = 64;
/// The most syllables accepted: as many as a timing can hold.
pub const MAX_ALIGNED_SYLLABLES: usize = song_file::MAX_SYLLABLES;
/// The most cells of the work grid, frames times alignment states. One cell
/// holds a one-byte back-pointer, so this is 256 MiB.
pub const MAX_GRID_CELLS: usize = 1 << 28;
/// The accepted frame lengths, in microseconds. At least 1 ms keeps every
/// syllable at least 1 ms long once times are rounded to milliseconds.
pub const FRAME_US: RangeInclusive<u32> = 1_000..=1_000_000;

/// A CTC model's output for the whole song.
#[derive(Debug, Clone, Copy)]
pub struct Emissions<'a> {
    /// The natural-log probability of every token in every frame, frame by
    /// frame: `frames × vocabulary.len()` values. Negative infinity means
    /// probability 0.
    pub log_probs: &'a [f32],
    /// The model's tokens, by index.
    pub vocabulary: &'a [String],
    /// The index of the blank token.
    pub blank: usize,
    /// The length of one frame, in microseconds. Frame `i` starts at
    /// `i × frame_us`.
    pub frame_us: u32,
}

/// The aligned syllables.
#[derive(Debug, Clone, PartialEq)]
pub struct Alignment {
    /// One time per syllable, in lyric order.
    pub timing: Timing,
    /// For each syllable, the model's average probability of the tokens the
    /// alignment chose over the syllable's frames, from 0 to 1.
    pub confidence: Vec<f32>,
}

/// Times every syllable of `lyrics` from `emissions`, within a song
/// `song_ms` long.
///
/// The checks run in a fixed order: vocabulary, blank, frame length, frames,
/// values, syllables, unknown syllables, work grid. A rejected input reports
/// the first rule it breaks.
pub fn align(
    lyrics: &Lyrics,
    emissions: &Emissions,
    song_ms: u32,
) -> Result<Alignment, AlignmentError> {
    let vocabulary = emissions.vocabulary;
    if vocabulary.len() > MAX_VOCABULARY {
        return Err(AlignmentError::VocabularyTooLarge {
            len: vocabulary.len(),
            limit: MAX_VOCABULARY,
        });
    }
    if vocabulary.is_empty() {
        return Err(AlignmentError::EmptyVocabulary);
    }
    if let Some((index, entry)) = vocabulary
        .iter()
        .enumerate()
        .find(|(_, entry)| entry.len() > MAX_TOKEN_BYTES)
    {
        return Err(AlignmentError::TokenTooLong {
            index,
            len: entry.len(),
            limit: MAX_TOKEN_BYTES,
        });
    }
    if emissions.blank >= vocabulary.len() {
        return Err(AlignmentError::BlankOutOfRange {
            blank: emissions.blank,
            len: vocabulary.len(),
        });
    }
    if !FRAME_US.contains(&emissions.frame_us) {
        return Err(AlignmentError::FrameLength {
            frame_us: emissions.frame_us,
        });
    }
    let width = vocabulary.len();
    let log_probs = emissions.log_probs;
    if log_probs.is_empty() || !log_probs.len().is_multiple_of(width) {
        return Err(AlignmentError::LogProbsLength {
            len: log_probs.len(),
            vocabulary: width,
        });
    }
    let frames = log_probs.len() / width;
    if frames > MAX_FRAMES {
        return Err(AlignmentError::TooManyFrames {
            frames,
            limit: MAX_FRAMES,
        });
    }
    if let Some(index) = log_probs
        .iter()
        .position(|&value| value.is_nan() || value == f32::INFINITY)
    {
        return Err(AlignmentError::NotALogProbability {
            frame: index / width,
            token: index % width,
        });
    }
    let count: usize = lyrics
        .lines()
        .iter()
        .map(|line| line.syllables().len())
        .sum();
    if count > MAX_ALIGNED_SYLLABLES {
        return Err(AlignmentError::TooManySyllables {
            count,
            limit: MAX_ALIGNED_SYLLABLES,
        });
    }
    let tokens = map_tokens(lyrics, vocabulary, emissions.blank)?;
    let grid = Grid {
        log_probs,
        width,
        blank: emissions.blank,
        tokens: &tokens,
    };
    grid_cells(frames, grid.states())?;
    let path = grid.best_path(frames)?;

    // The first and last frame of each syllable's tokens.
    let mut spans: Vec<Option<(usize, usize)>> = vec![None; count];
    for (frame, &state) in path.iter().enumerate() {
        if state % 2 == 1 {
            let span = &mut spans[tokens[state / 2].syllable];
            *span = Some(span.map_or((frame, frame), |(first, _)| (first, frame)));
        }
    }
    let ms = |frame: usize| {
        // At most MAX_FRAMES × 1,000,000 µs, about 50 hours, so it fits.
        ((frame as u64 * u64::from(emissions.frame_us) + 500) / 1_000) as u32
    };
    let mut times = Vec::with_capacity(count);
    let mut confidence = Vec::with_capacity(count);
    for (syllable, span) in spans.into_iter().enumerate() {
        // A path visits every token state, so every syllable has frames.
        let (first, last) = span.ok_or(AlignmentError::NoPath)?;
        let start_ms = ms(first);
        if start_ms >= song_ms {
            return Err(AlignmentError::PastEnd { syllable, song_ms });
        }
        times.push(SyllableTime {
            start_ms,
            end_ms: ms(last + 1).min(song_ms),
        });
        let total: f64 = (first..=last)
            .map(|frame| grid.emission(frame, path[frame]).exp())
            .sum();
        confidence.push((total / (last + 1 - first) as f64) as f32);
    }
    // Frames of a later syllable come after those of an earlier one, and a
    // frame is at least 1 ms, so the times always make a valid timing.
    let timing = Timing::new(times).map_err(|_| AlignmentError::NoPath)?;
    Ok(Alignment { timing, confidence })
}

/// One vocabulary token of the folded lyrics, and the syllable it belongs to.
#[derive(Debug, Clone, Copy)]
struct Token {
    id: usize,
    syllable: usize,
}

/// Maps every syllable to vocabulary tokens through a folded copy of its
/// text. A syllable with no known character fails.
fn map_tokens(
    lyrics: &Lyrics,
    vocabulary: &[String],
    blank: usize,
) -> Result<Vec<Token>, AlignmentError> {
    let mut lookup = HashMap::new();
    for (id, entry) in vocabulary.iter().enumerate() {
        if id != blank {
            lookup.entry(entry.nfc().collect::<String>()).or_insert(id);
        }
    }
    let text = lyrics.as_str();
    let mut tokens = Vec::new();
    let mut syllable = 0;
    for (lyric_line, line) in lyrics.lines().iter().enumerate() {
        for (position, range) in line.syllables().iter().enumerate() {
            let before = tokens.len();
            for c in text[range.range()].nfc() {
                tokens.extend(
                    fold(c, &lookup)
                        .into_iter()
                        .map(|id| Token { id, syllable }),
                );
            }
            if tokens.len() == before {
                return Err(AlignmentError::UnknownSyllable {
                    lyric_line,
                    position,
                });
            }
            syllable += 1;
        }
    }
    Ok(tokens)
}

/// The tokens for one character. It tries the character as written, then
/// lowercase, then uppercase, then its decomposed letters and marks, each as
/// written and then lowercase. It is empty when nothing matches.
fn fold(c: char, lookup: &HashMap<String, usize>) -> Vec<usize> {
    let find = |c: char| lookup.get(c.encode_utf8(&mut [0; 4]) as &str).copied();
    let find_all = |chars: &mut dyn Iterator<Item = char>| chars.map(find).collect::<Option<_>>();
    if let Some(id) = find(c) {
        return vec![id];
    }
    if let Some(ids) = find_all(&mut c.to_lowercase()) {
        return ids;
    }
    if let Some(ids) = find_all(&mut c.to_uppercase()) {
        return ids;
    }
    let mut ids = Vec::new();
    for part in std::iter::once(c).nfd() {
        if let Some(id) = find(part) {
            ids.push(id);
        } else if let Some(lower) = find_all(&mut part.to_lowercase()) {
            ids.extend(lower);
        }
    }
    ids
}

/// Checks that a work grid of `frames × states` cells is within the limit.
fn grid_cells(frames: usize, states: usize) -> Result<usize, AlignmentError> {
    match frames.checked_mul(states) {
        Some(cells) if cells <= MAX_GRID_CELLS => Ok(cells),
        cells => Err(AlignmentError::GridTooLarge {
            cells: cells.unwrap_or(usize::MAX),
            limit: MAX_GRID_CELLS,
        }),
    }
}

/// The standard CTC graph over the tokens. For L tokens there are 2L + 1
/// states: even states are the blank and state 2k + 1 is token k.
struct Grid<'a> {
    log_probs: &'a [f32],
    width: usize,
    blank: usize,
    tokens: &'a [Token],
}

impl Grid<'_> {
    fn states(&self) -> usize {
        2 * self.tokens.len() + 1
    }

    /// The log-probability of state `state`'s token in frame `frame`.
    fn emission(&self, frame: usize, state: usize) -> f64 {
        let token = if state.is_multiple_of(2) {
            self.blank
        } else {
            self.tokens[state / 2].id
        };
        f64::from(self.log_probs[frame * self.width + token])
    }

    /// The most likely path through the graph, one state per frame, by
    /// Viterbi. Call it only once the grid size is checked.
    fn best_path(&self, frames: usize) -> Result<Vec<usize>, AlignmentError> {
        let states = self.states();
        // How far back each cell's best path came from: 0, 1 or 2 states.
        let mut back = vec![0u8; frames * states];
        let mut previous = vec![f64::NEG_INFINITY; states];
        let mut current = vec![f64::NEG_INFINITY; states];
        previous[0] = self.emission(0, 0);
        previous[1] = self.emission(0, 1);
        for frame in 1..frames {
            for state in 0..states {
                let mut best = previous[state];
                let mut step = 0;
                if state >= 1 && previous[state - 1] > best {
                    best = previous[state - 1];
                    step = 1;
                }
                // A token may skip the blank before it, unless it repeats
                // the token before.
                if state >= 3
                    && state % 2 == 1
                    && self.tokens[state / 2].id != self.tokens[state / 2 - 1].id
                    && previous[state - 2] > best
                {
                    best = previous[state - 2];
                    step = 2;
                }
                current[state] = best + self.emission(frame, state);
                back[frame * states + state] = step;
            }
            std::mem::swap(&mut previous, &mut current);
        }
        let last = states - 1;
        let mut state = if previous[last - 1] > previous[last] {
            last - 1
        } else {
            last
        };
        if previous[state] == f64::NEG_INFINITY {
            return Err(AlignmentError::NoPath);
        }
        let mut path = vec![0; frames];
        for frame in (0..frames).rev() {
            path[frame] = state;
            state -= usize::from(back[frame * states + state]);
        }
        Ok(path)
    }
}

/// Why alignment failed. Fields count from 0. No message quotes the lyric or
/// vocabulary text.
#[derive(Debug, Clone, PartialEq)]
pub enum AlignmentError {
    /// The vocabulary has more than `limit` entries.
    VocabularyTooLarge { len: usize, limit: usize },
    /// The vocabulary has no entries.
    EmptyVocabulary,
    /// Vocabulary entry `index` is longer than `limit` bytes.
    TokenTooLong {
        index: usize,
        len: usize,
        limit: usize,
    },
    /// The blank index is not within the vocabulary.
    BlankOutOfRange { blank: usize, len: usize },
    /// The frame length is outside `FRAME_US`.
    FrameLength { frame_us: u32 },
    /// The number of log-probabilities is not a non-zero multiple of the
    /// vocabulary size.
    LogProbsLength { len: usize, vocabulary: usize },
    /// There are more than `limit` frames.
    TooManyFrames { frames: usize, limit: usize },
    /// The value for `token` in `frame` is NaN or positive infinity.
    NotALogProbability { frame: usize, token: usize },
    /// The lyrics have more than `limit` syllables.
    TooManySyllables { count: usize, limit: usize },
    /// Syllable `position` of lyric line `lyric_line` has no character the
    /// vocabulary knows.
    UnknownSyllable { lyric_line: usize, position: usize },
    /// The work grid would have more than `limit` cells.
    GridTooLarge { cells: usize, limit: usize },
    /// No path fits the syllables into the frames: too few frames, or every
    /// path has probability 0.
    NoPath,
    /// Syllable `syllable`, counting every syllable of the lyrics, starts at
    /// or after the end of the song.
    PastEnd { syllable: usize, song_ms: u32 },
}

impl fmt::Display for AlignmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AlignmentError::VocabularyTooLarge { len, limit } => write!(
                f,
                "the vocabulary has {len} entries, over the limit of {limit}"
            ),
            AlignmentError::EmptyVocabulary => write!(f, "the vocabulary is empty"),
            AlignmentError::TokenTooLong { index, len, limit } => write!(
                f,
                "vocabulary entry {} is {len} bytes, over the limit of {limit} bytes",
                index + 1
            ),
            AlignmentError::BlankOutOfRange { blank, len } => write!(
                f,
                "the blank token {} is not within the {len} vocabulary entries",
                blank + 1
            ),
            AlignmentError::FrameLength { frame_us } => write!(
                f,
                "a frame of {frame_us} µs is outside {} to {} µs",
                FRAME_US.start(),
                FRAME_US.end()
            ),
            AlignmentError::LogProbsLength { len, vocabulary } => write!(
                f,
                "{len} log-probabilities are not a whole number of frames of {vocabulary}"
            ),
            AlignmentError::TooManyFrames { frames, limit } => {
                write!(f, "there are {frames} frames, over the limit of {limit}")
            }
            AlignmentError::NotALogProbability { frame, token } => write!(
                f,
                "the value for token {} in frame {} is not a log-probability",
                token + 1,
                frame + 1
            ),
            AlignmentError::TooManySyllables { count, limit } => write!(
                f,
                "the lyrics have {count} syllables, over the limit of {limit}"
            ),
            AlignmentError::UnknownSyllable {
                lyric_line,
                position,
            } => write!(
                f,
                "syllable {} of lyric line {} has no character the model knows",
                position + 1,
                lyric_line + 1
            ),
            AlignmentError::GridTooLarge { cells, limit } => write!(
                f,
                "alignment needs {cells} work cells, over the limit of {limit}"
            ),
            AlignmentError::NoPath => write!(f, "the syllables do not fit the frames"),
            AlignmentError::PastEnd { syllable, song_ms } => write!(
                f,
                "syllable {} starts at or after the end of the song at {song_ms} ms",
                syllable + 1
            ),
        }
    }
}

impl std::error::Error for AlignmentError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The known-answer vocabulary. The blank is entry 0.
    const VOCABULARY: [&str; 7] = ["<pad>", "m", "ư", "a", "r", "ơ", "i"];
    /// The best token of each known-answer frame: "Mưa" in frames 1 to 3 and
    /// "rơi" in frames 6 to 8.
    const BEST: [usize; 10] = [0, 1, 2, 3, 0, 0, 4, 5, 6, 0];

    fn vocabulary(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|&entry| entry.to_owned()).collect()
    }

    /// Frames where token `best[i]` has probability 0.9 in frame `i`, and
    /// the other `width - 1` tokens share the rest.
    fn frames(width: usize, best: &[usize]) -> Vec<f32> {
        let rest = (0.1 / (width - 1) as f64).ln() as f32;
        let mut log_probs = vec![rest; width * best.len()];
        for (frame, &token) in best.iter().enumerate() {
            log_probs[frame * width + token] = 0.9f64.ln() as f32;
        }
        log_probs
    }

    fn lyrics(text: &str) -> Lyrics {
        Lyrics::parse(text.as_bytes()).expect("the lyrics are valid")
    }

    fn align_with(
        text: &str,
        entries: &[&str],
        log_probs: &[f32],
        song_ms: u32,
    ) -> Result<Alignment, AlignmentError> {
        let vocabulary = vocabulary(entries);
        let emissions = Emissions {
            log_probs,
            vocabulary: &vocabulary,
            blank: 0,
            frame_us: 20_000,
        };
        align(&lyrics(text), &emissions, song_ms)
    }

    fn times(alignment: &Alignment) -> Vec<(u32, u32)> {
        alignment
            .timing
            .syllables()
            .iter()
            .map(|time| (time.start_ms, time.end_ms))
            .collect()
    }

    fn known_answer(text: &str) -> Result<Alignment, AlignmentError> {
        align_with(text, &VOCABULARY, &frames(7, &BEST), 1_000)
    }

    fn known_answer_until(song_ms: u32) -> Result<Alignment, AlignmentError> {
        align_with("Mưa rơi", &VOCABULARY, &frames(7, &BEST), song_ms)
    }

    #[test]
    fn times_the_known_answer() {
        let alignment = known_answer("Mưa rơi").expect("it aligns");
        assert_eq!(times(&alignment), vec![(20, 80), (120, 180)]);
        assert_eq!(alignment.confidence.len(), 2);
        for confidence in alignment.confidence {
            assert!((confidence - 0.9).abs() < 1e-6, "{confidence}");
        }
    }

    #[test]
    fn folds_case_punctuation_bom_and_crlf_without_changing_the_lyrics() {
        let text = "\u{FEFF}Mưa, RƠI!\r\n";
        let parsed = lyrics(text);
        let vocabulary = vocabulary(&VOCABULARY);
        let log_probs = frames(7, &BEST);
        let emissions = Emissions {
            log_probs: &log_probs,
            vocabulary: &vocabulary,
            blank: 0,
            frame_us: 20_000,
        };
        let alignment = align(&parsed, &emissions, 1_000).expect("it aligns");
        assert_eq!(times(&alignment), vec![(20, 80), (120, 180)]);
        let count: usize = parsed.lines().iter().map(|l| l.syllables().len()).sum();
        assert_eq!(alignment.timing.syllables().len(), count);
        assert_eq!(parsed.as_bytes(), text.as_bytes());
    }

    #[test]
    fn folds_decomposed_lyrics() {
        let text: String = "mưa rơi".nfd().collect();
        assert_ne!(text, "mưa rơi");
        let alignment = known_answer(&text).expect("it aligns");
        assert_eq!(times(&alignment), vec![(20, 80), (120, 180)]);
    }

    #[test]
    fn matches_a_decomposed_vocabulary() {
        let entries = ["<pad>", "m", "u", "\u{31B}", "a", "r", "o", "i"];
        // "Mưa" is m u ̛ a, "rơi" is r o ̛ i.
        let best = [0, 1, 2, 3, 4, 0, 0, 5, 6, 3, 7, 0];
        let alignment =
            align_with("Mưa rơi", &entries, &frames(8, &best), 1_000).expect("it aligns");
        assert_eq!(times(&alignment), vec![(20, 100), (140, 220)]);
    }

    #[test]
    fn a_syllable_with_no_known_character_fails_by_its_place() {
        let error = known_answer("Mưa ♪\r\nrơi 2").expect_err("♪ is unknown");
        assert_eq!(
            error,
            AlignmentError::UnknownSyllable {
                lyric_line: 0,
                position: 1
            }
        );
        let message = error.to_string();
        assert_eq!(
            message,
            "syllable 2 of lyric line 1 has no character the model knows"
        );
        for text in ["♪", "Mưa", "rơi", "ư", "ơ"] {
            assert!(!message.contains(text), "{message}");
        }
        assert_eq!(
            known_answer("Mưa\nrơi 2"),
            Err(AlignmentError::UnknownSyllable {
                lyric_line: 1,
                position: 1
            })
        );
    }

    #[test]
    fn the_timing_passes_the_song_file_checks() {
        let parsed = lyrics("Mưa rơi");
        let vocabulary = vocabulary(&VOCABULARY);
        let log_probs = frames(7, &BEST);
        let emissions = Emissions {
            log_probs: &log_probs,
            vocabulary: &vocabulary,
            blank: 0,
            frame_us: 20_000,
        };
        let alignment = align(&parsed, &emissions, 1_000).expect("it aligns");
        assert_eq!(
            song_file::check_timing(&alignment.timing, &parsed, 1_000),
            Ok(())
        );
    }

    #[test]
    fn a_syllable_past_the_end_of_the_song_is_cut() {
        let parsed = lyrics("Mưa rơi");
        let vocabulary = vocabulary(&VOCABULARY);
        let log_probs = frames(7, &BEST);
        let emissions = Emissions {
            log_probs: &log_probs,
            vocabulary: &vocabulary,
            blank: 0,
            frame_us: 20_000,
        };
        let alignment = align(&parsed, &emissions, 170).expect("it aligns");
        assert_eq!(times(&alignment), vec![(20, 80), (120, 170)]);
        assert_eq!(
            song_file::check_timing(&alignment.timing, &parsed, 170),
            Ok(())
        );
    }

    #[test]
    fn a_syllable_starting_at_the_end_of_the_song_fails() {
        assert_eq!(
            known_answer_until(120),
            Err(AlignmentError::PastEnd {
                syllable: 1,
                song_ms: 120
            })
        );
        assert!(known_answer_until(121).is_ok());
    }

    #[test]
    fn a_repeated_token_needs_a_blank_between() {
        let entries = ["<pad>", "a"];
        assert_eq!(
            align_with("aa", &entries, &frames(2, &[1, 1]), 1_000),
            Err(AlignmentError::NoPath)
        );
        let alignment =
            align_with("aa", &entries, &frames(2, &[1, 0, 1]), 1_000).expect("it aligns");
        assert_eq!(times(&alignment), vec![(0, 60)]);
    }

    #[test]
    fn too_few_frames_have_no_path() {
        assert_eq!(
            align_with("Mưa rơi", &VOCABULARY, &frames(7, &BEST[..5]), 1_000),
            Err(AlignmentError::NoPath)
        );
    }

    #[test]
    fn a_probability_of_zero_everywhere_has_no_path() {
        let log_probs = vec![f32::NEG_INFINITY; 7 * 10];
        assert_eq!(
            align_with("Mưa rơi", &VOCABULARY, &log_probs, 1_000),
            Err(AlignmentError::NoPath)
        );
    }

    #[test]
    fn a_value_that_is_not_a_log_probability_is_rejected() {
        for value in [f32::NAN, f32::INFINITY] {
            let mut log_probs = frames(7, &BEST);
            log_probs[7 * 3 + 2] = value;
            assert_eq!(
                align_with("Mưa rơi", &VOCABULARY, &log_probs, 1_000),
                Err(AlignmentError::NotALogProbability { frame: 3, token: 2 })
            );
        }
    }

    #[test]
    fn a_malformed_input_is_rejected() {
        assert_eq!(
            align_with("a", &[], &[0.0], 1_000),
            Err(AlignmentError::EmptyVocabulary)
        );
        assert_eq!(
            align_with("Mưa rơi", &VOCABULARY, &[], 1_000),
            Err(AlignmentError::LogProbsLength {
                len: 0,
                vocabulary: 7
            })
        );
        assert_eq!(
            align_with("Mưa rơi", &VOCABULARY, &[0.0; 8], 1_000),
            Err(AlignmentError::LogProbsLength {
                len: 8,
                vocabulary: 7
            })
        );
        let parsed = lyrics("a");
        let vocabulary = vocabulary(&["<pad>", "a"]);
        let emissions = Emissions {
            log_probs: &[0.0, 0.0],
            vocabulary: &vocabulary,
            blank: 2,
            frame_us: 20_000,
        };
        assert_eq!(
            align(&parsed, &emissions, 1_000),
            Err(AlignmentError::BlankOutOfRange { blank: 2, len: 2 })
        );
    }

    #[test]
    fn the_frame_length_must_be_within_its_range() {
        let parsed = lyrics("a");
        let vocabulary = vocabulary(&["<pad>", "a"]);
        let log_probs = frames(2, &[1]);
        let with = |frame_us| {
            let emissions = Emissions {
                log_probs: &log_probs,
                vocabulary: &vocabulary,
                blank: 0,
                frame_us,
            };
            align(&parsed, &emissions, 2_000_000).map(|alignment| times(&alignment))
        };
        assert_eq!(with(1_000), Ok(vec![(0, 1)]));
        assert_eq!(with(1_000_000), Ok(vec![(0, 1_000)]));
        assert_eq!(
            with(999),
            Err(AlignmentError::FrameLength { frame_us: 999 })
        );
        assert_eq!(
            with(1_000_001),
            Err(AlignmentError::FrameLength {
                frame_us: 1_000_001
            })
        );
    }

    #[test]
    fn the_frame_count_is_limited() {
        let entries = ["<pad>", "a"];
        let at_limit = vec![0.5f32.ln(); 2 * MAX_FRAMES];
        assert!(align_with("a", &entries, &at_limit, u32::MAX).is_ok());
        let over = vec![0.5f32.ln(); 2 * (MAX_FRAMES + 1)];
        assert_eq!(
            align_with("a", &entries, &over, u32::MAX),
            Err(AlignmentError::TooManyFrames {
                frames: MAX_FRAMES + 1,
                limit: MAX_FRAMES
            })
        );
    }

    #[test]
    fn the_vocabulary_size_is_limited() {
        let entries = |len: usize| {
            let mut entries = vec!["<pad>".to_owned(), "a".to_owned()];
            entries.extend((2..len).map(|index| format!("t{index}")));
            entries
        };
        let parsed = lyrics("a");
        let with = |vocabulary: &[String]| {
            let log_probs = frames(vocabulary.len(), &[1]);
            let emissions = Emissions {
                log_probs: &log_probs,
                vocabulary,
                blank: 0,
                frame_us: 20_000,
            };
            align(&parsed, &emissions, 1_000)
        };
        assert!(with(&entries(MAX_VOCABULARY)).is_ok());
        assert_eq!(
            with(&entries(MAX_VOCABULARY + 1)),
            Err(AlignmentError::VocabularyTooLarge {
                len: MAX_VOCABULARY + 1,
                limit: MAX_VOCABULARY
            })
        );
    }

    #[test]
    fn the_vocabulary_entry_length_is_limited() {
        let at_limit = "x".repeat(MAX_TOKEN_BYTES);
        let over = "x".repeat(MAX_TOKEN_BYTES + 1);
        let log_probs = frames(3, &[1]);
        assert!(align_with("a", &["<pad>", "a", &at_limit], &log_probs, 1_000).is_ok());
        assert_eq!(
            align_with("a", &["<pad>", "a", &over], &log_probs, 1_000),
            Err(AlignmentError::TokenTooLong {
                index: 2,
                len: MAX_TOKEN_BYTES + 1,
                limit: MAX_TOKEN_BYTES
            })
        );
    }

    #[test]
    fn the_syllable_count_is_limited() {
        let entries = ["<pad>", "a"];
        let log_probs = frames(2, &[1]);
        // One frame is too few for this many syllables, but the count passes.
        let at_limit = "a ".repeat(MAX_ALIGNED_SYLLABLES);
        assert_eq!(
            align_with(&at_limit, &entries, &log_probs, 1_000),
            Err(AlignmentError::NoPath)
        );
        let over = "a ".repeat(MAX_ALIGNED_SYLLABLES + 1);
        assert_eq!(
            align_with(&over, &entries, &log_probs, 1_000),
            Err(AlignmentError::TooManySyllables {
                count: MAX_ALIGNED_SYLLABLES + 1,
                limit: MAX_ALIGNED_SYLLABLES
            })
        );
    }

    #[test]
    fn the_work_grid_is_limited() {
        // 746 syllables are 1,493 states. Over 180,000 frames that is
        // 268,740,000 cells, just over the limit.
        let text = "a ".repeat(746);
        let log_probs = vec![0.5f32.ln(); 2 * MAX_FRAMES];
        assert_eq!(
            align_with(&text, &["<pad>", "a"], &log_probs, u32::MAX),
            Err(AlignmentError::GridTooLarge {
                cells: 268_740_000,
                limit: MAX_GRID_CELLS
            })
        );
        // No odd number of states fills the limit exactly, so the check is
        // tested on its own.
        assert_eq!(grid_cells(1 << 14, 1 << 14), Ok(MAX_GRID_CELLS));
        assert_eq!(
            grid_cells(MAX_GRID_CELLS + 1, 1),
            Err(AlignmentError::GridTooLarge {
                cells: MAX_GRID_CELLS + 1,
                limit: MAX_GRID_CELLS
            })
        );
        assert_eq!(
            grid_cells(usize::MAX, 3),
            Err(AlignmentError::GridTooLarge {
                cells: usize::MAX,
                limit: MAX_GRID_CELLS
            })
        );
    }

    #[test]
    fn no_message_quotes_the_vocabulary() {
        let secret = "zzsecretzz".repeat(7);
        let error = align_with("a", &["<pad>", &secret], &[0.0, 0.0], 1_000)
            .expect_err("the entry is too long");
        assert!(!error.to_string().contains("zzsecretzz"));
    }
}
