//! Keeps word lookup in a WebAssembly module, so `scripts/build.sh` can
//! measure how many bytes the Wiktionary word list adds to it (D18). The
//! build compiles this module with and without the `wiktionary-words`
//! feature and compares the two.

use lyre_core::words::LineWords;

/// The number of gaps inside a word in a fixed two-syllable line.
#[unsafe(no_mangle)]
pub extern "C" fn gaps_inside_words() -> usize {
    let words = LineWords::find(std::hint::black_box(&["kỷ", "niệm"]));
    (0..words.gap_count())
        .filter(|&gap| words.gap_inside_word(gap))
        .count()
}
