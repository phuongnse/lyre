//! `lyre-cli`: a developer tool that builds version-0 song files from small
//! fixtures, with timing written by hand.
//!
//! The manifest and the timing file are described in
//! `docs/reference/lyre-cli.md`. The media files are WebM init and media
//! segments cut beforehand. The tool treats them as opaque bytes, as the core
//! does.

pub mod timing;

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use lyre_core::lyrics::{Lyrics, LyricsError};
use lyre_core::song_file::{self, Segment, Song, SongDetails, SongFileError, Timing, Track};
use serde::Deserialize;

use crate::timing::TimingFileError;

/// The manifest: where the parts of the song are, and its details. Paths are
/// relative to the manifest's folder.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    song_id: String,
    lyrics: String,
    timing: String,
    thumbnail: Option<String>,
    details: Details,
    video: Option<TrackSpec>,
    karaoke: TrackSpec,
    original: TrackSpec,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Details {
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    composer: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrackSpec {
    init: String,
    segments: Vec<SegmentSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SegmentSpec {
    file: String,
    duration_ms: u32,
}

/// Builds the song file that the manifest at `manifest` describes, and
/// returns its bytes. Nothing is written.
pub fn build(manifest: &Path) -> Result<Vec<u8>, BuildError> {
    let text = fs::read_to_string(manifest).map_err(|source| BuildError::Read {
        path: manifest.to_path_buf(),
        source,
    })?;
    let spec: Manifest = toml::from_str(&text).map_err(BuildError::Manifest)?;
    let dir = manifest.parent().unwrap_or(Path::new(""));
    let read = |name: &str| {
        let path = dir.join(name);
        fs::read(&path).map_err(|source| BuildError::Read { path, source })
    };

    let song_id = parse_song_id(&spec.song_id).ok_or(BuildError::SongId)?;
    // The lyrics bytes go to the core unchanged (D5).
    let lyrics = Lyrics::parse(&read(&spec.lyrics)?).map_err(BuildError::Lyrics)?;
    let times =
        timing::parse(&read(&spec.timing)?, &lyrics).map_err(|error| BuildError::Timing {
            path: dir.join(&spec.timing),
            error,
        })?;
    let timing = Timing::new(times).map_err(BuildError::SongFile)?;
    let details = SongDetails::new(
        spec.details.title,
        spec.details.artist,
        spec.details.composer,
    )
    .map_err(BuildError::SongFile)?;
    let thumbnail = spec.thumbnail.as_deref().map(read).transpose()?;
    let track = |spec: &TrackSpec| -> Result<Track, BuildError> {
        let segments = spec
            .segments
            .iter()
            .map(|segment| {
                Ok(Segment {
                    duration_ms: segment.duration_ms,
                    bytes: read(&segment.file)?,
                })
            })
            .collect::<Result<_, BuildError>>()?;
        Ok(Track {
            init: read(&spec.init)?,
            segments,
        })
    };
    let song = Song {
        song_id,
        details,
        thumbnail,
        lyrics,
        timing,
        video: spec.video.as_ref().map(track).transpose()?,
        karaoke: track(&spec.karaoke)?,
        original: track(&spec.original)?,
    };
    song_file::write(&song).map_err(BuildError::SongFile)
}

/// Reads a song ID written as exactly 32 hex digits.
fn parse_song_id(text: &str) -> Option<[u8; 16]> {
    let bytes = text.as_bytes();
    if bytes.len() != 32 || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let mut id = [0u8; 16];
    for (byte, pair) in id.iter_mut().zip(bytes.chunks(2)) {
        let pair = std::str::from_utf8(pair).ok()?;
        *byte = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(id)
}

/// Why a song file could not be built.
#[derive(Debug)]
pub enum BuildError {
    /// A file named by the manifest, or the manifest itself, could not be
    /// read.
    Read { path: PathBuf, source: io::Error },
    /// The manifest is not valid TOML or does not have the expected fields.
    Manifest(toml::de::Error),
    /// The song ID is not 32 hex digits.
    SongId,
    /// The core rejected the lyrics.
    Lyrics(LyricsError),
    /// The timing file breaks a rule.
    Timing {
        path: PathBuf,
        error: TimingFileError,
    },
    /// The core rejected the song.
    SongFile(SongFileError),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BuildError::Read { path, source } => {
                write!(f, "cannot read {}: {source}", path.display())
            }
            BuildError::Manifest(error) => write!(f, "manifest is not valid: {error}"),
            BuildError::SongId => write!(f, "song_id must be exactly 32 hex digits"),
            BuildError::Lyrics(error) => write!(f, "lyrics rejected: {error}"),
            BuildError::Timing { path, error } => write!(f, "{} {error}", path.display()),
            BuildError::SongFile(error) => write!(f, "song rejected: {error}"),
        }
    }
}

impl std::error::Error for BuildError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            BuildError::Read { source, .. } => Some(source),
            BuildError::Manifest(error) => Some(error),
            BuildError::SongId => None,
            BuildError::Lyrics(error) => Some(error),
            BuildError::Timing { error, .. } => Some(error),
            BuildError::SongFile(error) => Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_song_id;

    #[test]
    fn reads_a_song_id_of_32_hex_digits() {
        let id = parse_song_id("00112233445566778899aabbccddEEFF").expect("valid song ID");
        assert_eq!(
            id,
            [
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff
            ]
        );
    }

    #[test]
    fn rejects_other_song_ids() {
        for text in [
            "",
            "00112233445566778899aabbccddeef",
            "00112233445566778899aabbccddeeff00",
            "00112233445566778899aabbccddeefg",
            "+0112233445566778899aabbccddeeff",
        ] {
            assert_eq!(parse_song_id(text), None, "{text}");
        }
    }
}
