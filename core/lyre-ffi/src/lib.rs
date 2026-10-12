//! UniFFI bindings of the Lyre core, for the Android app.

uniffi::setup_scaffolding!();

/// The version of the Lyre core.
#[uniffi::export]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
}

#[cfg(test)]
mod tests {
    use super::core_version;

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }
}
