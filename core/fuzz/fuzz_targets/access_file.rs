#![no_main]

use std::sync::LazyLock;

use libfuzzer_sys::fuzz_target;
use lyre_core::access;
use lyre_core::device::DeviceKey;

// The 'Access file' vector in docs/reference/device-access.md: the Device PRF output 000102…1f and the song ID 000102…0f.
static DEVICE: LazyLock<DeviceKey> = LazyLock::new(|| {
    let prf: [u8; 32] = std::array::from_fn(|i| i as u8);
    DeviceKey::from_prf_output(&prf).expect("the vector PRF output gives a device key")
});
const SONG_ID: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

fuzz_target!(|data: &[u8]| {
    let _ = access::open(data, &DEVICE, &SONG_ID);
});
