#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::device::PublicKey;

fuzz_target!(|data: &[u8]| {
    if let Ok(text) = str::from_utf8(data) {
        let _ = PublicKey::parse_device_code(text);
    }
});
