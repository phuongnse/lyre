//! A song's content key, held as an opaque handle.
//!
//! The key's bytes stay inside [`ContentKey`]: no public function returns
//! them, and its `Debug` text shows nothing of them. The handle wipes its
//! bytes when dropped.

use std::fmt;

use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

/// The size of a content key, in bytes.
pub(crate) const KEY_LEN: usize = 32;

/// A song's 32-byte content key. It has no `Clone`, no `AsRef`, no `Deref`,
/// no `Display` and no conversion to bytes.
///
/// ```
/// use lyre_core::content_key::ContentKey;
///
/// let fixed = ContentKey::from_bytes([0x40; 32]);
/// let fresh = ContentKey::generate();
/// ```
///
/// The bytes cannot be read back:
///
/// ```compile_fail
/// let key = lyre_core::content_key::ContentKey::from_bytes([0x40; 32]);
/// let _: [u8; 32] = key.to_bytes();
/// ```
///
/// ```compile_fail
/// let key = lyre_core::content_key::ContentKey::from_bytes([0x40; 32]);
/// let _ = key.bytes;
/// ```
///
/// ```compile_fail
/// let key = lyre_core::content_key::ContentKey::from_bytes([0x40; 32]);
/// let _: &[u8] = key.as_ref();
/// ```
///
/// ```compile_fail
/// let key = lyre_core::content_key::ContentKey::from_bytes([0x40; 32]);
/// let _ = *key;
/// ```
///
/// ```compile_fail
/// let key = lyre_core::content_key::ContentKey::from_bytes([0x40; 32]);
/// let _ = key.clone();
/// ```
pub struct ContentKey {
    bytes: Zeroizing<[u8; KEY_LEN]>,
}

impl fmt::Debug for ContentKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ContentKey {{ .. }}")
    }
}

impl ContentKey {
    /// Makes a content key from fresh random bytes from the operating
    /// system, or from the browser on WebAssembly.
    pub fn generate() -> ContentKey {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        OsRng.fill_bytes(bytes.as_mut_slice());
        ContentKey { bytes }
    }

    /// Makes a content key from the given bytes. This is for tests and
    /// known-answer vectors. Real content keys come from [`generate`].
    ///
    /// [`generate`]: ContentKey::generate
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> ContentKey {
        ContentKey {
            bytes: Zeroizing::new(bytes),
        }
    }

    /// The bytes, for the crate's own sealing code.
    pub(crate) fn expose(&self) -> &[u8; KEY_LEN] {
        &self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_text_holds_no_key_bytes() {
        let bytes: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        let key = ContentKey::from_bytes(bytes);
        let text = format!("{key:?}");
        assert_eq!(text, "ContentKey { .. }");
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert!(!text.contains(&hex));
        assert!(!text.contains("0x40"));
    }

    #[test]
    fn generated_keys_differ_and_are_not_zero() {
        let a = ContentKey::generate();
        let b = ContentKey::generate();
        assert_ne!(a.expose(), b.expose());
        assert_ne!(a.expose(), &[0u8; 32]);
        assert_ne!(b.expose(), &[0u8; 32]);
    }
}
