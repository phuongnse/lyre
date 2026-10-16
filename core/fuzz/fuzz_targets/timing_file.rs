#![no_main]

use std::sync::LazyLock;

use libfuzzer_sys::fuzz_target;
use lyre_core::lyrics::Lyrics;
use lyre_core::timing_file;

static LYRICS: LazyLock<Lyrics> = LazyLock::new(|| {
    Lyrics::parse(include_bytes!("../../../tests/fixtures/song/lyrics.txt"))
        .expect("the fixture lyrics parse")
});

fuzz_target!(|data: &[u8]| {
    let _ = timing_file::parse(data, &LYRICS);
});
