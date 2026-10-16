#![no_main]

use libfuzzer_sys::fuzz_target;
use lyre_core::song_file::{HEADER_LEN, Header, Index};

// The input is the file size as 8 little-endian bytes, then the header and the index.
fuzz_target!(|data: &[u8]| {
    let Some((size, rest)) = data.split_first_chunk::<8>() else {
        return;
    };
    let file_size = u64::from_le_bytes(*size);
    let Ok(header) = Header::parse(rest) else {
        return;
    };
    if let Some(index) = rest.get(HEADER_LEN..HEADER_LEN + header.index_len()) {
        let _ = Index::parse(&header, index, file_size);
    }
});
