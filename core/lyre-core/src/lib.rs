//! The shared Lyre core. The web client and the Android app both call it.

pub mod alignment;
pub mod alignment_windows;
pub mod countdown;
pub mod display_lines;
pub mod highlight;
pub mod lyrics;
pub mod lyrics_rows;
pub mod model;
pub mod onset_error;
pub mod separation;
pub mod song_file;
pub mod timing_file;
pub mod words;

/// The version of the Lyre core, from the workspace package version.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn version_equals_workspace_package_version() {
        let manifest: toml::Table = include_str!("../../Cargo.toml")
            .parse()
            .expect("core/Cargo.toml is valid TOML");
        let expected = manifest["workspace"]["package"]["version"]
            .as_str()
            .expect("workspace package version is a string");
        assert_eq!(version(), expected);
    }
}
