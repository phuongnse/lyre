#![no_main]

use std::sync::LazyLock;

use libfuzzer_sys::fuzz_target;
use lyre_core::lyrics::Lyrics;
use lyre_core::song_file::{self, Chunk, ChunkType, IndexEntry, MAX_SONG_MS};

static LYRICS: LazyLock<Lyrics> = LazyLock::new(|| {
    Lyrics::parse(include_bytes!("../../../tests/fixtures/song/lyrics.txt"))
        .expect("the fixture lyrics parse")
});

fuzz_target!(|data: &[u8]| {
    let Ok(length) = u32::try_from(data.len()) else {
        return;
    };
    let entry = IndexEntry {
        chunk_type: ChunkType::Timing,
        length,
        offset: 0,
        start_ms: 0,
        duration_ms: 0,
    };
    if let Ok(Chunk::Timing(timing)) = song_file::read_chunk(&entry, data) {
        let _ = song_file::check_timing(&timing, &LYRICS, MAX_SONG_MS);
    }
});
