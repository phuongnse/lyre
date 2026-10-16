//! Writes the seed inputs of the fuzz targets in `core/fuzz`:
//! `fuzz_seeds <song.toml> <out-dir>` writes files to `<out-dir>/<target>/`.
//! `scripts/fuzz.sh` runs it before every fuzzing run. The seeds come from the
//! fixture song and the known-answer vectors in `docs/reference/device-access.md`,
//! so they stay in step with the format and no song file is committed.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use lyre_core::access::{self, Role};
use lyre_core::content_key::ContentKey;
use lyre_core::device::DeviceKey;
use lyre_core::song_file::{ChunkType, HEADER_LEN, Header, Index};

/// The 'Access file' vector: the Device PRF output `000102…1f`, the song ID
/// `000102…0f` and the content key `404142…5f`.
const DEVICE_PRF: [u8; 32] = byte_ramp(0x00);
const SONG_ID: [u8; 16] = byte_ramp(0x00);
const CONTENT_KEY: [u8; 32] = byte_ramp(0x40);

/// The valid 24-word rows of the 'Recovery key' vector.
const VALID_WORDS: [&str; 3] = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "gather arch occur silver filter crisp payment coil hidden gloom fortune ten alpha rice soccer modify island rookie bundle visual result dirt wheat trust",
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
];

/// The refused rows of the same vector.
const REFUSED_WORDS: [&str; 8] = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandonn",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon artt",
    "aban abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ar",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
    "gather arctic occur silver filter crisp payment coil hidden gloom fortune ten alpha rice soccer modify island rookie bundle visual result dirt wheat trust",
];

/// `N` bytes counting up from `first`.
const fn byte_ramp<const N: usize>(first: u8) -> [u8; N] {
    let mut bytes = [0u8; N];
    let mut i = 0;
    while i < N {
        bytes[i] = first + i as u8;
        i += 1;
    }
    bytes
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [manifest, out] = args.as_slice() else {
        return Err("usage: fuzz_seeds <song.toml> <out-dir>".into());
    };
    let manifest = Path::new(manifest);
    let out = PathBuf::from(out);
    let dir = manifest.parent().unwrap_or(Path::new(""));
    let write = |target: &str, name: &str, bytes: &[u8]| -> Result<(), Box<dyn Error>> {
        let folder = out.join(target);
        fs::create_dir_all(&folder)?;
        fs::write(folder.join(name), bytes)?;
        Ok(())
    };

    let device = DeviceKey::from_prf_output(&DEVICE_PRF)?;
    let device_public_key = device.public_key();

    // Whole song files: version 0, and version 1 with its access file.
    let v0 = lyre_cli::build(manifest)?;
    let v1 = lyre_cli::build_for_device(manifest, &device_public_key)?;
    for target in ["song_file_read", "song_file_header"] {
        write(target, "v0", &v0)?;
        write(target, "v1", &v1.song_file)?;
    }
    write("access_file", "built", &v1.access_file)?;
    let wrapped = access::wrap(
        &ContentKey::from_bytes(CONTENT_KEY),
        &SONG_ID,
        &device_public_key,
        Role::Owner,
    );
    write("access_file", "vector", &wrapped)?;
    write(
        "device_code",
        "vector",
        device_public_key.device_code().as_bytes(),
    )?;

    // The index: the file size, then the header and the index.
    let header = Header::parse(&v0)?;
    let head = v0
        .get(..HEADER_LEN + header.index_len())
        .ok_or("the fixture song file is shorter than its index")?;
    let mut index_seed = (v0.len() as u64).to_le_bytes().to_vec();
    index_seed.extend_from_slice(head);
    write("song_file_index", "v0", &index_seed)?;

    // The chunks that are not media segments: the type code, then the chunk bytes.
    let index = Index::parse(&header, &head[HEADER_LEN..], v0.len() as u64)?;
    for (position, entry) in index.entries().iter().enumerate() {
        if entry.chunk_type.is_segment() {
            continue;
        }
        let start = usize::try_from(entry.offset)?;
        let bytes = v0
            .get(start..start + usize::try_from(entry.length)?)
            .ok_or("a chunk of the fixture song file is out of range")?;
        let mut seed = entry.chunk_type.code().to_le_bytes().to_vec();
        seed.extend_from_slice(bytes);
        write("song_file_chunk", &format!("chunk-{position}"), &seed)?;
        match entry.chunk_type {
            ChunkType::Timing => write("timing", "fixture", bytes)?,
            ChunkType::Lyrics => write("lyrics", "chunk", bytes)?,
            _ => {}
        }
    }

    write("lyrics", "fixture", &fs::read(dir.join("lyrics.txt"))?)?;
    write("timing_file", "fixture", &fs::read(dir.join("timing.txt"))?)?;

    for (n, words) in VALID_WORDS.iter().enumerate() {
        write("recovery_words", &format!("valid-{n}"), words.as_bytes())?;
    }
    for (n, words) in REFUSED_WORDS.iter().enumerate() {
        write("recovery_words", &format!("refused-{n}"), words.as_bytes())?;
    }
    Ok(())
}
