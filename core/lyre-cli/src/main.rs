//! `lyre-cli build <manifest.toml> <out.lyre>`: builds a version-0 song file
//! for development. See `docs/reference/lyre-cli.md`.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "usage: lyre-cli build <manifest.toml> <out.lyre>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [command, manifest, out] = args.as_slice() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    if command != "build" {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    match run(Path::new(manifest), Path::new(out)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("lyre-cli: {message}");
            ExitCode::from(1)
        }
    }
}

/// Builds the song file, then writes it. Nothing is written when the build
/// fails.
fn run(manifest: &Path, out: &Path) -> Result<(), String> {
    let bytes = lyre_cli::build(manifest).map_err(|error| error.to_string())?;
    if let Some(parent) = out.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    fs::write(out, bytes).map_err(|error| format!("cannot write {}: {error}", out.display()))
}
