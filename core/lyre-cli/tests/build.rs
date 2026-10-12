//! Builds the fixture song in `tests/fixtures/song` and reads it back with
//! the core.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use lyre_core::song_file::{self, SyllableTime};

/// The largest total size of every file under `tests/fixtures`, in bytes.
const MAX_FIXTURES_BYTES: u64 = 65_536;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

fn song_dir() -> PathBuf {
    fixtures().join("song")
}

fn read(name: &str) -> Vec<u8> {
    fs::read(song_dir().join(name)).expect("fixture file is readable")
}

fn build_fixture() -> Vec<u8> {
    lyre_cli::build(&song_dir().join("song.toml")).expect("fixture song builds")
}

#[test]
fn fixture_song_reads_back_with_its_lyrics_and_timing() {
    let song = song_file::read(&build_fixture()).expect("the core reads the built song");

    assert_eq!(song.lyrics.as_bytes(), read("lyrics.txt").as_slice());
    let expected = [
        (0, 300),
        (300, 600),
        (600, 1200),
        (1500, 1800),
        (1800, 2100),
        (2100, 2400),
        (2400, 2900),
    ]
    .map(|(start_ms, end_ms)| SyllableTime { start_ms, end_ms });
    assert_eq!(song.timing.syllables(), expected.as_slice());
    assert_eq!(song.details.title(), "Mưa rơi nhẹ");
    assert_eq!(song.details.artist(), "Lyre fixtures");
    assert_eq!(song.details.composer(), "");
    assert_eq!(song.thumbnail, Some(read("thumbnail.jpg")));
    assert_eq!(song.karaoke.init, read("karaoke/init.webm"));
    assert_eq!(song.original.init, read("original/init.webm"));

    let video = song.video.expect("the fixture has a video");
    assert_eq!(video.init, read("video/init.webm"));
    assert_eq!(video.segments.len(), 3);
    assert_eq!(song.karaoke.segments.len(), 3);
    assert_eq!(song.original.segments.len(), 3);
    for (index, (karaoke, original)) in song
        .karaoke
        .segments
        .iter()
        .zip(&song.original.segments)
        .enumerate()
    {
        let name = format!("karaoke/segment-{}.webm", index + 1);
        assert_eq!(karaoke.bytes, read(&name));
        assert_ne!(karaoke.bytes, original.bytes, "{name}");
    }
}

#[test]
fn command_writes_the_built_song() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let out = dir.path().join("new/fixture.lyre");
    let output = Command::new(env!("CARGO_BIN_EXE_lyre-cli"))
        .arg("build")
        .arg(song_dir().join("song.toml"))
        .arg(&out)
        .output()
        .expect("lyre-cli runs");

    assert!(output.status.success(), "{output:?}");
    assert_eq!(fs::read(&out).expect("output is written"), build_fixture());
}

#[test]
fn command_rejects_bad_timing_and_writes_nothing() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // The third line starts before the second syllable ends.
    let timing = dir.path().join("timing.txt");
    fs::write(
        &timing,
        "# bad\n0 300 Mưa\n200 600 rơi\n600 1200 nhẹ\n1500 1800 Em\n1800 2100 về\n2100 2400 bên\n2400 2900 sông\n",
    )
    .expect("timing is written");
    let manifest = dir.path().join("song.toml");
    fs::write(&manifest, manifest_with_timing(&timing)).expect("manifest is written");
    let out = dir.path().join("bad.lyre");

    let output = Command::new(env!("CARGO_BIN_EXE_lyre-cli"))
        .arg("build")
        .arg(&manifest)
        .arg(&out)
        .output()
        .expect("lyre-cli runs");

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(!out.exists());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr.contains("line 3"), "{stderr}");
    for syllable in ["Mưa", "rơi"] {
        assert!(!stderr.contains(syllable), "{stderr}");
    }
}

#[test]
fn command_without_its_arguments_prints_usage() {
    let output = Command::new(env!("CARGO_BIN_EXE_lyre-cli"))
        .arg("build")
        .output()
        .expect("lyre-cli runs");

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr.contains("usage: lyre-cli build"), "{stderr}");
}

/// The fixture manifest with absolute paths to the fixture files, and with
/// `timing` as its timing file.
fn manifest_with_timing(timing: &Path) -> String {
    let text = fs::read_to_string(song_dir().join("song.toml")).expect("manifest is readable");
    let mut manifest: toml::Table = text.parse().expect("manifest is valid TOML");
    let absolute = |name: &toml::Value| {
        let name = name.as_str().expect("path is a string");
        toml::Value::from(song_dir().join(name).to_str().expect("UTF-8 path"))
    };
    for key in ["lyrics", "thumbnail"] {
        manifest[key] = absolute(&manifest[key]);
    }
    manifest["timing"] = toml::Value::from(timing.to_str().expect("UTF-8 path"));
    for track in ["video", "karaoke", "original"] {
        let track = manifest[track].as_table_mut().expect("track is a table");
        track["init"] = absolute(&track["init"]);
        for segment in track["segments"].as_array_mut().expect("segments") {
            segment["file"] = absolute(&segment["file"]);
        }
    }
    manifest.to_string()
}

#[test]
fn fixtures_total_at_most_64_kib() {
    fn total(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .expect("fixture folder is readable")
            .map(|entry| {
                let entry = entry.expect("fixture entry");
                let kind = entry.file_type().expect("file type");
                if kind.is_dir() {
                    total(&entry.path())
                } else {
                    entry.metadata().expect("metadata").len()
                }
            })
            .sum()
    }
    let size = total(&fixtures());
    assert!(size <= MAX_FIXTURES_BYTES, "fixtures are {size} bytes");
}
