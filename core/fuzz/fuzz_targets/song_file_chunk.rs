#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::song_file::{self, ChunkType, IndexEntry};

// The input is the chunk type code as 2 little-endian bytes, then the chunk bytes.
fuzz_target!(|data: &[u8]| {
    let Some((code, bytes)) = data.split_first_chunk::<2>() else {
        return;
    };
    let Some(chunk_type) = ChunkType::from_code(u16::from_le_bytes(*code)) else {
        return;
    };
    let Ok(length) = u32::try_from(bytes.len()) else {
        return;
    };
    let entry = IndexEntry {
        chunk_type,
        length,
        offset: 0,
        start_ms: 0,
        duration_ms: 0,
    };
    let _ = song_file::read_chunk(&entry, bytes);
});
