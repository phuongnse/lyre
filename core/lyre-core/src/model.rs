//! The pinned model files, and the check of a download against them. Both
//! clients use the same list and the same check, so they agree on which
//! model bytes may run.

use sha2::{Digest, Sha256};

/// A model file pinned to exact bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct PinnedFile {
    /// The ID clients use to name the file.
    pub id: &'static str,
    /// Where the file is downloaded from, at a fixed revision. The tests
    /// check that every URL names a full commit, never a branch or a tag.
    pub url: &'static str,
    /// The file's size in bytes.
    pub size: u64,
    /// The file's SHA-256, as 64 lowercase hex digits.
    pub sha256: &'static str,
}

/// Every pinned model file.
// These are test entries only, built from the SHA-256 test vectors of
// FIPS 180-2. Their host never resolves, so no client can download them. The
// real models come with a later issue.
pub const PINNED_FILES: &[PinnedFile] = &[
    PinnedFile {
        id: "test-empty",
        url: "https://example.invalid/lyre-test/resolve/0123456789abcdef0123456789abcdef01234567/empty.bin",
        size: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    PinnedFile {
        id: "test-two-block",
        url: "https://example.invalid/lyre-test/resolve/0123456789abcdef0123456789abcdef01234567/two-block.bin",
        size: 56,
        sha256: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    },
];

/// The pinned file with this `id`, if there is one.
pub fn pinned_file(id: &str) -> Option<&'static PinnedFile> {
    PINNED_FILES.iter().find(|file| file.id == id)
}

/// The result of a check: the file's ID and whether it passed. It holds no
/// file bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCheckResult {
    pub id: &'static str,
    pub passed: bool,
}

/// Checks a download against its pinned file, one piece at a time. It keeps
/// only the hash state, never the bytes it was fed.
#[derive(Clone)]
pub struct ModelCheck {
    file: &'static PinnedFile,
    hasher: Sha256,
    fed: u64,
    too_long: bool,
}

impl ModelCheck {
    /// Starts a check of the pinned file with this `id`. There is none for
    /// an unknown ID.
    pub fn new(id: &str) -> Option<ModelCheck> {
        pinned_file(id).map(|file| ModelCheck {
            file,
            hasher: Sha256::new(),
            fed: 0,
            too_long: false,
        })
    }

    /// Hashes the next `piece` of the download. Returns false once the file
    /// has grown past its pinned size. It then ignores every piece.
    pub fn feed(&mut self, piece: &[u8]) -> bool {
        if self.too_long {
            return false;
        }
        let fed = u64::try_from(piece.len())
            .ok()
            .and_then(|length| self.fed.checked_add(length));
        match fed {
            Some(fed) if fed <= self.file.size => {
                self.hasher.update(piece);
                self.fed = fed;
                true
            }
            _ => {
                self.too_long = true;
                false
            }
        }
    }

    /// The result so far. It passes only when exactly the pinned size was
    /// fed and the SHA-256 matches.
    pub fn result(&self) -> ModelCheckResult {
        let passed = !self.too_long && self.fed == self.file.size && {
            let hash: String = self
                .hasher
                .clone()
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            hash == self.file.sha256
        };
        ModelCheckResult {
            id: self.file.id,
            passed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// True when `url` is `https://` and names a full commit, as a Hugging
    /// Face URL with `/resolve/<40 lowercase hex digits>/` does. A branch or
    /// a tag can move, so it does not count.
    fn names_fixed_revision(url: &str) -> bool {
        if !url.starts_with("https://") {
            return false;
        }
        url.match_indices("/resolve/").any(|(start, marker)| {
            let rest = &url.as_bytes()[start + marker.len()..];
            rest.len() > 40
                && rest[..40]
                    .iter()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                && rest[40] == b'/'
        })
    }

    /// The 56-byte two-block test vector of FIPS 180-2.
    const TWO_BLOCK: &[u8] = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";

    /// Feeds `pieces` to a check of `id`, in order, and gives its result.
    fn check(id: &str, pieces: &[&[u8]]) -> ModelCheckResult {
        let mut check = ModelCheck::new(id).expect("a pinned ID");
        for piece in pieces {
            check.feed(piece);
        }
        check.result()
    }

    fn passed(id: &'static str) -> ModelCheckResult {
        ModelCheckResult { id, passed: true }
    }

    fn failed(id: &'static str) -> ModelCheckResult {
        ModelCheckResult { id, passed: false }
    }

    #[test]
    fn both_test_entries_pass_when_fed_whole() {
        assert_eq!(check("test-empty", &[b""]), passed("test-empty"));
        assert_eq!(
            check("test-two-block", &[TWO_BLOCK]),
            passed("test-two-block")
        );
    }

    #[test]
    fn the_empty_entry_passes_with_no_pieces() {
        assert_eq!(check("test-empty", &[]), passed("test-empty"));
    }

    #[test]
    fn the_two_block_entry_passes_when_fed_in_uneven_pieces() {
        let t = TWO_BLOCK;
        assert_eq!(
            check("test-two-block", &[&t[..1], &t[1..8], &t[8..]]),
            passed("test-two-block")
        );
        assert_eq!(
            check("test-two-block", &[&t[..0], &t[..55], b"", &t[55..]]),
            passed("test-two-block")
        );
        let bytes: Vec<&[u8]> = t.chunks(1).collect();
        assert_eq!(check("test-two-block", &bytes), passed("test-two-block"));
    }

    #[test]
    fn the_two_block_entry_fails_one_byte_short() {
        assert_eq!(
            check("test-two-block", &[&TWO_BLOCK[..55]]),
            failed("test-two-block")
        );
    }

    #[test]
    fn the_two_block_entry_fails_one_byte_long() {
        assert_eq!(
            check("test-two-block", &[TWO_BLOCK, b"q"]),
            failed("test-two-block")
        );
    }

    #[test]
    fn the_two_block_entry_fails_with_one_byte_changed() {
        let mut changed = TWO_BLOCK.to_vec();
        changed[20] ^= 0x01;
        assert_eq!(
            check("test-two-block", &[&changed]),
            failed("test-two-block")
        );
    }

    #[test]
    fn feeding_past_the_pinned_size_fails_at_once_and_for_good() {
        let mut check = ModelCheck::new("test-two-block").expect("a pinned ID");
        assert!(check.feed(TWO_BLOCK));
        assert_eq!(check.result(), passed("test-two-block"));
        assert!(!check.feed(b"q"));
        assert_eq!(check.result(), failed("test-two-block"));
        assert!(!check.feed(b""));
        assert_eq!(check.result(), failed("test-two-block"));
    }

    #[test]
    fn a_piece_that_takes_the_total_past_the_pinned_size_fails_at_once() {
        let mut check = ModelCheck::new("test-two-block").expect("a pinned ID");
        assert!(check.feed(&TWO_BLOCK[..50]));
        assert!(!check.feed(&TWO_BLOCK[49..]));
        assert!(!check.feed(&TWO_BLOCK[50..]));
        assert_eq!(check.result(), failed("test-two-block"));
        let mut empty = ModelCheck::new("test-empty").expect("a pinned ID");
        assert!(!empty.feed(b"a"));
        assert!(!empty.feed(b""));
        assert_eq!(empty.result(), failed("test-empty"));
    }

    #[test]
    fn an_unknown_id_gives_no_check() {
        assert!(ModelCheck::new("no-such-model").is_none());
        assert_eq!(pinned_file("no-such-model"), None);
    }

    #[test]
    fn every_pinned_url_names_a_fixed_revision() {
        for file in PINNED_FILES {
            assert!(names_fixed_revision(file.url), "{}", file.url);
        }
    }

    #[test]
    fn a_branch_name_is_not_a_fixed_revision() {
        let url = PINNED_FILES[0].url;
        let revision = url
            .split("/resolve/")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .expect("a revision");
        let on_main = url.replace(revision, "main");
        assert!(on_main.contains("/resolve/main/"));
        assert!(!names_fixed_revision(&on_main));
    }

    #[test]
    fn other_revisions_are_not_fixed() {
        let hex = "0123456789abcdef0123456789abcdef01234567";
        assert!(names_fixed_revision(&format!(
            "https://huggingface.co/a/b/resolve/{hex}/m.onnx"
        )));
        for url in [
            format!("http://huggingface.co/a/b/resolve/{hex}/m.onnx"),
            format!("https://huggingface.co/a/b/resolve/{}/m.onnx", &hex[..39]),
            format!("https://huggingface.co/a/b/resolve/{hex}0/m.onnx"),
            format!(
                "https://huggingface.co/a/b/resolve/{}/m.onnx",
                hex.to_uppercase()
            ),
            format!("https://huggingface.co/a/b/resolve/{hex}"),
            "https://huggingface.co/a/b/resolve/v1.0/m.onnx".to_owned(),
        ] {
            assert!(!names_fixed_revision(&url), "{url}");
        }
    }

    #[test]
    fn pinned_ids_are_unique_and_hashes_are_lowercase_hex() {
        for (index, file) in PINNED_FILES.iter().enumerate() {
            assert!(
                PINNED_FILES[..index]
                    .iter()
                    .all(|other| other.id != file.id),
                "{}",
                file.id
            );
            assert_eq!(file.sha256.len(), 64, "{}", file.id);
            assert!(
                file.sha256
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
                "{}",
                file.id
            );
        }
    }
}
