#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::song_file;

fuzz_target!(|data: &[u8]| {
    let _ = song_file::Header::parse(data);
    let _ = song_file::v1::Header::parse(data);
});
