//! `lyre-cli build <manifest.toml> <out.lyre> [--device-code <code> --access
//! <out.lyrekey>]`: builds a song file for development. It writes version 0,
//! or version 1 and an access file when given a device code. See
//! `docs/reference/lyre-cli.md`.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use lyre_core::device::PublicKey;

const USAGE: &str = "usage: lyre-cli build <manifest.toml> <out.lyre> [--device-code <code> --access <out.lyrekey>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["build", manifest, out] => run(Path::new(manifest), Path::new(out)),
        [
            "build",
            manifest,
            out,
            "--device-code",
            code,
            "--access",
            access,
        ] => match PublicKey::parse_device_code(code) {
            Ok(device) => run_for_device(
                Path::new(manifest),
                Path::new(out),
                &device,
                Path::new(access),
            ),
            Err(error) => {
                eprintln!("lyre-cli: {error}");
                return ExitCode::from(2);
            }
        },
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("lyre-cli: {message}");
            ExitCode::from(1)
        }
    }
}

/// Builds the version-0 song file, then writes it. Nothing is written when
/// the build fails.
fn run(manifest: &Path, out: &Path) -> Result<(), String> {
    let bytes = lyre_cli::build(manifest).map_err(|error| error.to_string())?;
    write(out, bytes)
}

/// Builds the version-1 song file and the access file, then writes the song
/// file and the access file. Nothing is written when the build fails.
fn run_for_device(
    manifest: &Path,
    out: &Path,
    device: &PublicKey,
    access: &Path,
) -> Result<(), String> {
    let build = lyre_cli::build_for_device(manifest, device).map_err(|error| error.to_string())?;
    write(out, build.song_file)?;
    write(access, build.access_file)
}

/// Creates the file's folder if needed, then writes the file.
fn write(path: &Path, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|error| format!("cannot write {}: {error}", path.display()))
}
