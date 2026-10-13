//! UniFFI bindings of the Lyre core, for the Android app.

use std::sync::{Arc, Mutex};

use lyre_core::model;

uniffi::setup_scaffolding!();

/// The version of the Lyre core.
#[uniffi::export]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
}

/// The result of a model check: the file's ID and whether it passed. It
/// holds no file bytes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ModelCheckResult {
    pub id: String,
    pub passed: bool,
}

/// Checks a downloaded model file against its pinned size and SHA-256. The
/// app feeds the download in pieces. The check keeps only the hash state,
/// never the bytes.
#[derive(uniffi::Object)]
pub struct ModelCheck {
    check: Mutex<model::ModelCheck>,
}

/// Starts a check of the pinned model file with this `id`. There is none for
/// an unknown ID.
#[uniffi::export]
pub fn start_model_check(id: String) -> Option<Arc<ModelCheck>> {
    model::ModelCheck::new(&id).map(|check| {
        Arc::new(ModelCheck {
            check: Mutex::new(check),
        })
    })
}

#[uniffi::export]
impl ModelCheck {
    /// Hashes the next `piece` of the download. Returns false once the file
    /// has grown past its pinned size, and the app should stop. Every later
    /// piece is then ignored.
    pub fn feed(&self, piece: Vec<u8>) -> bool {
        // A poisoned lock counts as a failed check.
        self.check
            .lock()
            .map(|mut check| check.feed(&piece))
            .unwrap_or(false)
    }

    /// The result so far. It passes only when exactly the pinned size was
    /// fed and the SHA-256 matches.
    pub fn result(&self) -> ModelCheckResult {
        // A poisoned lock counts as a failed check.
        let result = match self.check.lock() {
            Ok(check) => check.result(),
            Err(poisoned) => model::ModelCheckResult {
                passed: false,
                ..poisoned.into_inner().result()
            },
        };
        ModelCheckResult {
            id: result.id.to_owned(),
            passed: result.passed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 56-byte two-block test vector of FIPS 180-2.
    const TWO_BLOCK: &[u8] = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }

    #[test]
    fn a_model_check_passes_for_the_pinned_bytes() {
        let check = start_model_check("test-two-block".to_owned()).expect("a pinned ID");
        assert!(check.feed(TWO_BLOCK[..30].to_vec()));
        assert!(check.feed(TWO_BLOCK[30..].to_vec()));
        assert_eq!(
            check.result(),
            ModelCheckResult {
                id: "test-two-block".to_owned(),
                passed: true,
            }
        );
    }

    #[test]
    fn a_model_check_fails_one_byte_long() {
        let check = start_model_check("test-two-block".to_owned()).expect("a pinned ID");
        assert!(check.feed(TWO_BLOCK.to_vec()));
        assert!(!check.feed(b"q".to_vec()));
        assert_eq!(
            check.result(),
            ModelCheckResult {
                id: "test-two-block".to_owned(),
                passed: false,
            }
        );
    }

    #[test]
    fn an_unknown_model_gives_no_check() {
        assert!(start_model_check("no-such-model".to_owned()).is_none());
    }
}
