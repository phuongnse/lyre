#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::recovery::RecoveryKey;

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = str::from_utf8(data) {
        let _ = RecoveryKey::from_words(text);
    }
});
