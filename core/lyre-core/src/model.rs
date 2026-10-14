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
    /// check that every real file's URL names a full commit on Hugging Face,
    /// never a branch or a tag. A test entry's URL is relative to the site.
    pub url: &'static str,
    /// The file's size in bytes.
    pub size: u64,
    /// The file's SHA-256, as 64 lowercase hex digits.
    pub sha256: &'static str,
}

/// Every pinned model file. Its `id` also names the file in a client's
/// storage, so it uses only lowercase letters, digits and `-`.
// The real files are the rows of docs/reference/models.md, and a test keeps
// them identical. Each `test-` entry is a file of tests/fixtures/models/. The
// first two are SHA-256 test vectors of FIPS 180-2. The Kim-shaped test
// separator is made by tools/model-tool/make_test_separator.py, and the
// test aligner's two by tools/model-tool/make_test_aligners.py. Their URLs are
// relative `test-models/` paths that only the e2e server serves, so no release
// site has them.
pub const PINNED_FILES: &[PinnedFile] = &[
    PinnedFile {
        id: "mel-roformer-fp16",
        url: "https://huggingface.co/phuongnse/mel-roformer-kim-onnx/resolve/9151f81ee8e4f7dd96598dbeeb1b186b939911be/mel-roformer.fp16.onnx",
        size: 464_050_097,
        sha256: "adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef",
    },
    PinnedFile {
        id: "lyric-alignment-fp32",
        url: "https://huggingface.co/phuongnse/lyric-alignment-onnx/resolve/ec46b2179bfbe521e22c36d0c08bd3993c63fe71/model.onnx",
        size: 1_275_253_998,
        sha256: "02eda699db61269dc37620d3778fb8e8f88b67a95dbd1e0e60657dfc8afb6779",
    },
    PinnedFile {
        id: "lyric-alignment-int8",
        url: "https://huggingface.co/phuongnse/lyric-alignment-onnx/resolve/ec46b2179bfbe521e22c36d0c08bd3993c63fe71/model.int8.onnx",
        size: 359_796_311,
        sha256: "0071840476677e53e1cd9881246a3d2890bad812096282ebe1ac1bd676c23099",
    },
    PinnedFile {
        id: "lyric-alignment-vocab",
        url: "https://huggingface.co/phuongnse/lyric-alignment-onnx/resolve/ec46b2179bfbe521e22c36d0c08bd3993c63fe71/vocab.json",
        size: 1_169,
        sha256: "4339e2cb5c97554f089fe317120e794efce3f7626ad205fb496d34bddd2c6ae7",
    },
    PinnedFile {
        id: "test-empty",
        url: "test-models/empty.bin",
        size: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    PinnedFile {
        id: "test-two-block",
        url: "test-models/two-block.bin",
        size: 56,
        sha256: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    },
    PinnedFile {
        id: "test-mel-roformer",
        url: "test-models/mel-roformer.onnx",
        size: 191,
        sha256: "c760a5f7e9387cefc876da59d10f11c87d97ff216ea3b1cdd880b571968197b8",
    },
    PinnedFile {
        id: "test-lyric-alignment-model",
        url: "test-models/lyric-alignment.onnx",
        size: 611,
        sha256: "cd34cac739463129e43d515bcd868f5c03000e68441c6d2bd4617efcffa18e37",
    },
    PinnedFile {
        id: "test-lyric-alignment-vocab",
        url: "test-models/lyric-alignment-vocab.json",
        size: 214,
        sha256: "8c6e39d34b4d38349bfcec8aa261bf937e464b62b1c99732ea6a9296358e2aa0",
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
    fn the_test_mel_roformer_entry_passes_with_the_committed_file() {
        let model = include_bytes!("../../../tests/fixtures/models/mel-roformer.onnx");
        assert_eq!(
            check("test-mel-roformer", &[model]),
            passed("test-mel-roformer")
        );
    }

    #[test]
    fn the_test_aligner_entries_pass_with_the_committed_files() {
        let files: [(&str, &[u8]); 2] = [
            (
                "test-lyric-alignment-model",
                include_bytes!("../../../tests/fixtures/models/lyric-alignment.onnx"),
            ),
            (
                "test-lyric-alignment-vocab",
                include_bytes!("../../../tests/fixtures/models/lyric-alignment-vocab.json"),
            ),
        ];
        for (id, bytes) in files {
            assert_eq!(check(id, &[bytes]), passed(id));
        }
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

    /// The real model files: every entry but the test entries.
    fn real_files() -> impl Iterator<Item = &'static PinnedFile> {
        PINNED_FILES
            .iter()
            .filter(|file| !file.id.starts_with("test-"))
    }

    #[test]
    fn every_real_url_names_a_fixed_revision_on_hugging_face() {
        assert!(real_files().count() > 0);
        for file in real_files() {
            assert!(
                file.url.starts_with("https://huggingface.co/"),
                "{}",
                file.url
            );
            assert!(names_fixed_revision(file.url), "{}", file.url);
        }
    }

    #[test]
    fn every_test_url_is_a_plain_path_under_test_models() {
        let tests: Vec<_> = PINNED_FILES
            .iter()
            .filter(|file| file.id.starts_with("test-"))
            .collect();
        assert_eq!(tests.len(), 5);
        for file in tests {
            assert!(file.url.starts_with("test-models/"), "{}", file.url);
            for part in [":", "..", "//"] {
                assert!(!file.url.contains(part), "{}", file.url);
            }
        }
    }

    #[test]
    fn pinned_ids_use_only_lowercase_letters_digits_and_hyphens() {
        for file in PINNED_FILES {
            assert!(!file.id.is_empty());
            assert!(
                file.id
                    .bytes()
                    .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-')),
                "{}",
                file.id
            );
        }
    }

    #[test]
    fn a_branch_name_is_not_a_fixed_revision() {
        let url = real_files().next().expect("a real file").url;
        let revision = url
            .split("/resolve/")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .expect("a revision");
        let on_main = url.replace(revision, "main");
        assert!(on_main.contains("/resolve/main/"));
        assert!(!names_fixed_revision(&on_main));
    }

    const MODELS_DOC: &str = include_str!("../../../docs/reference/models.md");

    /// The (URL, size, SHA-256) of each table row of the models reference,
    /// read as its "Checking the pins" command reads them.
    fn documented_files() -> Vec<(String, u64, String)> {
        let mut files = Vec::new();
        for line in MODELS_DOC.lines() {
            if !line.starts_with("| `") {
                continue;
            }
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            let [_, repo, revision, path, size, sha256, _] = cells[..] else {
                continue;
            };
            let code = |cell: &str| cell.strip_prefix('`')?.strip_suffix('`').map(str::to_owned);
            let (Some(repo), Some(revision), Some(path), Some(sha256)) =
                (code(repo), code(revision), code(path), code(sha256))
            else {
                continue;
            };
            let Ok(size) = size.replace(',', "").parse::<u64>() else {
                continue;
            };
            if revision.len() != 40 || sha256.len() != 64 {
                continue;
            }
            files.push((
                format!("https://huggingface.co/{repo}/resolve/{revision}/{path}"),
                size,
                sha256,
            ));
        }
        files
    }

    #[test]
    fn the_real_files_are_the_rows_of_the_models_reference() {
        let documented = documented_files();
        assert_eq!(documented.len(), 4);
        let documented: std::collections::BTreeSet<_> = documented.into_iter().collect();
        let pinned: std::collections::BTreeSet<_> = real_files()
            .map(|file| (file.url.to_owned(), file.size, file.sha256.to_owned()))
            .collect();
        assert_eq!(pinned, documented);
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
