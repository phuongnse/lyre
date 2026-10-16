#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::content_key::ContentKey;
use lyre_core::song_file::{self, v1};

// A fixed key never opens a version 1 file made by a seed, so that reader stops at the header and the tag.
// The chunk parsers it shares with version 0 are reached through version 0.
fuzz_target!(|data: &[u8]| {
    let _ = song_file::read(data);
    let _ = v1::read(data, &ContentKey::from_bytes([0x40; 32]));
});
