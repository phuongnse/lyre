//! `lyre-cli`: a developer tool that builds song files from small fixtures,
//! with timing written by hand. It writes version 0 by default. Given a device
//! code, it writes version 1 and an access file for that device.
//!
//! The manifest and the timing file are described in
//! `docs/reference/lyre-cli.md`. The media files are init and media
//! segments cut beforehand, and the manifest gives each track's MSE type. The
//! tool treats the media as opaque bytes, as the core does.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use lyre_core::access::{self, Role};
use lyre_core::content_key::ContentKey;
use lyre_core::device::PublicKey;
use lyre_core::lyrics::{Lyrics, LyricsError};
use lyre_core::recovery::{RecoveryKey, RecoveryPublicKey};
use lyre_core::song_file::v1::{self, Salt};
use lyre_core::song_file::{
    self, Segment, Song, SongDetails, SongFileError, Timing, Track, VocalRole,
};
use lyre_core::timing_file::{self, TimingFileError};
use rand_core::{OsRng, RngCore};
use serde::Deserialize;

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
    vocal_role: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrackSpec {
    /// The track's MSE type. It is required, because a default could label a
    /// track with the wrong codec.
    #[serde(rename = "type")]
    stored_type: String,
    init: String,
    segments: Vec<SegmentSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SegmentSpec {
    file: String,
    duration_ms: u32,
}

/// Builds the version-0 song file that the manifest at `manifest` describes,
/// and returns its bytes. Nothing is written.
pub fn build(manifest: &Path) -> Result<Vec<u8>, BuildError> {
    song_file::write(&song(manifest)?).map_err(BuildError::SongFile)
}

/// The two files of a version-1 build: the song file and its access file.
/// There is no `Debug`, so the bytes cannot reach a log by accident.
pub struct DeviceBuild {
    pub song_file: Vec<u8>,
    pub access_file: Vec<u8>,
}

/// Builds the version-1 song file that the manifest at `manifest` describes,
/// with a fresh content key, and an access file that wraps the key for
/// `device` with the owner role. The content key leaves this function only
/// inside the access file. Nothing is written.
pub fn build_for_device(manifest: &Path, device: &PublicKey) -> Result<DeviceBuild, BuildError> {
    let song = song(manifest)?;
    let content_key = ContentKey::generate();
    let song_file = v1::write(
        &song,
        &content_key,
        &throwaway_recovery_key(),
        Salt::generate(),
    )
    .map_err(BuildError::SongFile)?;
    let access_file = access::wrap(&content_key, &song.song_id, device, Role::Owner);
    Ok(DeviceBuild {
        song_file,
        access_file,
    })
}

/// The recovery public key for a development build. Its private key is made
/// from fresh random bytes and dropped here, so no one can recover these
/// files.
fn throwaway_recovery_key() -> RecoveryPublicKey {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    // A zero scalar has a negligible chance.
    RecoveryKey::from_seed(&seed)
        .expect("a random seed gives a recovery key")
        .public_key()
}

/// Reads the manifest at `manifest` and the files it names into a song.
fn song(manifest: &Path) -> Result<Song, BuildError> {
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
        timing_file::parse(&read(&spec.timing)?, &lyrics).map_err(|error| BuildError::Timing {
            path: dir.join(&spec.timing),
            error,
        })?;
    let timing = Timing::new(times).map_err(BuildError::SongFile)?;
    let vocal_role = parse_vocal_role(&spec.details.vocal_role).ok_or(BuildError::VocalRole)?;
    let details = SongDetails::new(
        spec.details.title,
        spec.details.artist,
        spec.details.composer,
        vocal_role,
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
            // lyre-cli writes every track from 0.
            start_ms: 0,
            stored_type: spec.stored_type.clone(),
            init: read(&spec.init)?,
            segments,
        })
    };
    Ok(Song {
        song_id,
        details,
        thumbnail,
        lyrics,
        timing,
        video: spec.video.as_ref().map(track).transpose()?,
        karaoke: track(&spec.karaoke)?,
        original: track(&spec.original)?,
    })
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

/// Reads a vocal role written as exactly "male" or "female".
fn parse_vocal_role(text: &str) -> Option<VocalRole> {
    match text {
        "male" => Some(VocalRole::Male),
        "female" => Some(VocalRole::Female),
        _ => None,
    }
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
    /// The vocal role is not "male" or "female".
    VocalRole,
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
            BuildError::VocalRole => write!(f, r#"vocal_role must be "male" or "female""#),
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
            BuildError::SongId | BuildError::VocalRole => None,
            BuildError::Lyrics(error) => Some(error),
            BuildError::Timing { error, .. } => Some(error),
            BuildError::SongFile(error) => Some(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use lyre_core::song_file::VocalRole;

    use super::{parse_song_id, parse_vocal_role};

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

    #[test]
    fn reads_a_vocal_role_of_male_or_female() {
        assert_eq!(parse_vocal_role("male"), Some(VocalRole::Male));
        assert_eq!(parse_vocal_role("female"), Some(VocalRole::Female));
        for text in ["tenor", "Male", "", " male"] {
            assert_eq!(parse_vocal_role(text), None, "{text}");
        }
    }
}
