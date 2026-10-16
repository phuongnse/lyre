#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::lyrics::Lyrics;

fuzz_target!(|data: &[u8]| {
    let _ = Lyrics::parse(data);
});
