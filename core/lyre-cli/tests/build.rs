//! Builds the fixture song in `tests/fixtures/song` and reads it back with
//! the core.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use lyre_core::song_file::{self, SyllableTime, VocalRole};

/// The largest total size of every file under `tests/fixtures`, in bytes.
const MAX_FIXTURES_BYTES: u64 = 73_728;

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
        (2000, 2300),
        (2300, 2600),
        (2600, 3200),
        (3500, 3800),
        (3800, 4100),
        (4100, 4400),
        (4400, 4900),
        (9900, 10400),
        (10400, 11000),
    ]
    .map(|(start_ms, end_ms)| SyllableTime { start_ms, end_ms });
    assert_eq!(song.timing.syllables(), expected.as_slice());
    assert_eq!(song.details.title(), "Mưa rơi nhẹ");
    assert_eq!(song.details.artist(), "Lyre fixtures");
    assert_eq!(song.details.composer(), "Lyre fixture composer");
    assert_eq!(song.details.vocal_role(), VocalRole::Female);
    assert_eq!(song.thumbnail, Some(read("thumbnail.jpg")));
    assert_eq!(song.karaoke.stored_type, r#"audio/webm; codecs="opus""#);
    assert_eq!(song.karaoke.init, read("karaoke/init.webm"));
    assert_eq!(song.original.stored_type, r#"audio/webm; codecs="opus""#);
    assert_eq!(song.original.init, read("original/init.webm"));

    let video = song.video.expect("the fixture has a video");
    assert_eq!(video.stored_type, r#"video/webm; codecs="vp09.00.40.08""#);
    assert_eq!(video.init, read("video/init.webm"));
    assert_eq!(video.segments.len(), 6);
    assert_eq!(song.karaoke.segments.len(), 6);
    assert_eq!(song.original.segments.len(), 6);
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
        "# bad\n2000 2300 Mưa\n2200 2600 rơi\n2600 3200 nhẹ\n3500 3800 Em\n3800 4100 về\n4100 4400 bên\n4400 4900 sông\n9900 10400 Trăng\n10400 11000 lên\n",
    )
    .expect("timing is written");
    let mut manifest = absolute_manifest();
    manifest["timing"] = toml::Value::from(timing.to_str().expect("UTF-8 path"));
    let manifest = write_manifest(dir.path(), &manifest);
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

#[test]
fn manifest_without_a_vocal_role_is_rejected() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let mut manifest = absolute_manifest();
    manifest["details"]
        .as_table_mut()
        .expect("details is a table")
        .remove("vocal_role")
        .expect("the fixture has a vocal role");

    let err = lyre_cli::build(&write_manifest(dir.path(), &manifest)).unwrap_err();
    assert!(err.to_string().contains("vocal_role"), "{err}");
}

#[test]
fn manifest_with_an_unknown_vocal_role_is_rejected() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let mut manifest = absolute_manifest();
    manifest["details"]["vocal_role"] = toml::Value::from("tenor");

    let err = lyre_cli::build(&write_manifest(dir.path(), &manifest)).unwrap_err();
    assert!(err.to_string().contains("vocal_role"), "{err}");
}

#[test]
fn manifest_track_without_a_type_is_rejected() {
    for track in ["video", "karaoke", "original"] {
        let dir = tempfile::tempdir().expect("temporary folder");
        let mut manifest = absolute_manifest();
        manifest[track]
            .as_table_mut()
            .expect("track is a table")
            .remove("type")
            .expect("the fixture track has a type");

        let err = lyre_cli::build(&write_manifest(dir.path(), &manifest)).unwrap_err();
        assert!(err.to_string().contains("type"), "{track}: {err}");
    }
}

#[test]
fn manifest_track_with_a_type_in_the_wrong_container_is_rejected() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let mut manifest = absolute_manifest();
    manifest["original"]["type"] = toml::Value::from(r#"video/webm; codecs="vp9""#);

    let err = lyre_cli::build(&write_manifest(dir.path(), &manifest)).unwrap_err();
    assert!(err.to_string().contains("container"), "{err}");
}

/// A manifest's lines after its header comment.
fn body(name: &str) -> String {
    let text = fs::read_to_string(song_dir().join(name)).expect("manifest is readable");
    text.lines()
        .skip_while(|line| line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `male.toml` is `song.toml` with its own header comment and a male vocal role.
#[test]
fn male_manifest_differs_from_the_fixture_only_in_its_vocal_role() {
    let female = body("song.toml");
    assert!(female.contains("vocal_role = \"female\""), "{female}");
    let expected = female.replacen("vocal_role = \"female\"", "vocal_role = \"male\"", 1);
    assert_eq!(body("male.toml"), expected);
}

/// `h265.toml` is `song.toml` with its own header comment and an H.265 video
/// type.
#[test]
fn h265_manifest_differs_from_the_fixture_only_in_its_video_type() {
    let vp9 = r#"type = 'video/webm; codecs="vp09.00.40.08"'"#;
    let h265 = r#"type = 'video/mp4; codecs="hvc1.1.6.L93.B0"'"#;
    let song = body("song.toml");
    assert!(song.contains(&format!("[video]\n{vp9}")), "{song}");
    assert_eq!(body("h265.toml"), song.replacen(vp9, h265, 1));

    let built = lyre_cli::build(&song_dir().join("h265.toml")).expect("the H.265 variant builds");
    let video = song_file::read(&built)
        .expect("the core reads it")
        .video
        .expect("it has a video");
    assert_eq!(video.stored_type, r#"video/mp4; codecs="hvc1.1.6.L93.B0""#);
}

/// The fixture manifest with absolute paths to the fixture files.
fn absolute_manifest() -> toml::Table {
    let text = fs::read_to_string(song_dir().join("song.toml")).expect("manifest is readable");
    let mut manifest: toml::Table = text.parse().expect("manifest is valid TOML");
    let absolute = |name: &toml::Value| {
        let name = name.as_str().expect("path is a string");
        toml::Value::from(song_dir().join(name).to_str().expect("UTF-8 path"))
    };
    for key in ["lyrics", "timing", "thumbnail"] {
        manifest[key] = absolute(&manifest[key]);
    }
    for track in ["video", "karaoke", "original"] {
        let track = manifest[track].as_table_mut().expect("track is a table");
        track["init"] = absolute(&track["init"]);
        for segment in track["segments"].as_array_mut().expect("segments") {
            segment["file"] = absolute(&segment["file"]);
        }
    }
    manifest
}

/// Writes `manifest` to `song.toml` in `dir` and returns its path.
fn write_manifest(dir: &Path, manifest: &toml::Table) -> PathBuf {
    let path = dir.join("song.toml");
    fs::write(&path, manifest.to_string()).expect("manifest is written");
    path
}

#[test]
fn fixtures_total_at_most_72_kib() {
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
