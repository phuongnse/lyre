//! The recovery key: its words, its key pair and the recovery wrap.
//!
//! The bytes are in `docs/reference/device-access.md#recovery-key` and
//! `docs/reference/song-file-format-v1.md#recovery-wrap`. The recovery private
//! key stays inside [`RecoveryKey`]: no function returns its bytes, and its
//! `Debug` text shows nothing of it. [`NewRecoveryKey`] makes a key from fresh
//! randomness and gives its words once. [`RecoveryKey::from_words`] reads them
//! back, and [`recover_access`] opens a song with them for a new device.

mod words;

use std::fmt;

use hpke::aead::AesGcm256;
use hpke::kdf::HkdfSha256;
use hpke::kem::DhP256HkdfSha256;
use hpke::{Deserializable, OpModeR, OpModeS, Serializable, single_shot_open, single_shot_seal};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{NonZeroScalar, SecretKey};
use rand_core::{CryptoRng, OsRng, RngCore};
use zeroize::Zeroizing;

use crate::access::{self, Role};
use crate::content_key::{ContentKey, KEY_LEN};
use crate::device::{DeviceCodeError, PublicKey};
use crate::scalar::derive_scalar;
use crate::song_file::{SongFileError, v1};

pub use words::RecoveryWordsError;

/// The HKDF `info` of the recovery key pair.
const RECOVERY_KEY_INFO: &[u8] = b"lyre/v1/recovery-key";

/// The start of the HPKE `info` of the recovery wrap.
const WRAP_LABEL: &[u8] = b"lyre/v1/recovery-wrap";

/// The size of a recovery seed, in bytes.
const SEED_LEN: usize = 32;

/// The size of a song ID, in bytes.
const SONG_ID_LEN: usize = 16;

/// The size of a compressed P-256 public key, in bytes.
const COMPRESSED_LEN: usize = 33;

/// The size of `recovery_enc`, an uncompressed P-256 point, in bytes.
pub const ENC_LEN: usize = 65;

/// The size of `recovery_sealed`, the content key and its tag, in bytes.
pub const SEALED_LEN: usize = KEY_LEN + 16;

/// The size of the HPKE `info`, in bytes.
const INFO_LEN: usize = WRAP_LABEL.len() + SONG_ID_LEN + COMPRESSED_LEN;

type Kem = DhP256HkdfSha256;

/// Why a recovery key pair could not be derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryKeyError {
    /// The reduced scalar is zero.
    ZeroScalar,
}

impl fmt::Display for RecoveryKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecoveryKeyError::ZeroScalar => write!(f, "the derived private scalar is zero"),
        }
    }
}

impl std::error::Error for RecoveryKeyError {}

/// Why a recovery wrap could not be opened. A structural error is kept apart
/// from an authentication failure. Every authentication failure gives the
/// same error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryWrapError {
    /// `recovery_enc` is not a valid uncompressed P-256 point.
    Enc,
    /// The open failed authentication.
    Open,
}

impl fmt::Display for RecoveryWrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecoveryWrapError::Enc => write!(f, "the recovery wrap holds no valid point"),
            RecoveryWrapError::Open => write!(f, "the recovery wrap did not open"),
        }
    }
}

impl std::error::Error for RecoveryWrapError {}

/// Why a recovery public key could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryPublicKeyError {
    /// The key is not 33 bytes.
    Length,
    /// The prefix is not `02` or `03`, or the key is not a point on the
    /// P-256 curve.
    Key,
}

impl fmt::Display for RecoveryPublicKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecoveryPublicKeyError::Length => write!(f, "the recovery public key is not 33 bytes"),
            RecoveryPublicKeyError::Key => {
                write!(f, "the recovery public key is not a valid point")
            }
        }
    }
}

impl std::error::Error for RecoveryPublicKeyError {}

/// The owner's recovery key pair. The private key stays inside and cannot be
/// read.
pub struct RecoveryKey {
    secret: SecretKey,
}

impl fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RecoveryKey {{ .. }}")
    }
}

impl RecoveryKey {
    /// Derives the key pair from a 32-byte recovery seed. The same seed
    /// always gives the same key pair.
    pub fn from_seed(seed: &[u8; SEED_LEN]) -> Result<RecoveryKey, RecoveryKeyError> {
        RecoveryKey::from_scalar(derive_scalar(seed, RECOVERY_KEY_INFO))
    }

    fn from_scalar(scalar: Option<NonZeroScalar>) -> Result<RecoveryKey, RecoveryKeyError> {
        let scalar = scalar.ok_or(RecoveryKeyError::ZeroScalar)?;
        Ok(RecoveryKey {
            secret: SecretKey::from(scalar),
        })
    }

    /// Derives the key pair from the 24 recovery words, typed or scanned.
    /// Lowercase and uppercase both work, with any whitespace between the
    /// words. A seed whose derived scalar is zero gives
    /// [`RecoveryWordsError::ZeroScalar`]. No real seed is known to do that.
    pub fn from_words(text: &str) -> Result<RecoveryKey, RecoveryWordsError> {
        let seed = words::seed_from_words(text)?;
        RecoveryKey::from_seed(&seed).map_err(|_| RecoveryWordsError::ZeroScalar)
    }

    /// The public key.
    pub fn public_key(&self) -> RecoveryPublicKey {
        RecoveryPublicKey(self.secret.public_key())
    }
}

/// A recovery key that was just made. It holds the seed only to give its
/// words, and wipes the seed when it drops. Nothing can turn a key pair back
/// into words later, so the owner is shown the words once.
pub struct NewRecoveryKey {
    seed: Zeroizing<[u8; SEED_LEN]>,
    public_key: RecoveryPublicKey,
}

impl fmt::Debug for NewRecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NewRecoveryKey {{ .. }}")
    }
}

impl NewRecoveryKey {
    /// Makes a recovery key from fresh randomness.
    pub fn generate() -> NewRecoveryKey {
        NewRecoveryKey::generate_with_rng(&mut OsRng)
    }

    /// Makes a key from the given random source. A seed whose scalar is zero
    /// is drawn again. Only tests fix the source.
    pub(crate) fn generate_with_rng<R: RngCore + CryptoRng>(rng: &mut R) -> NewRecoveryKey {
        loop {
            let mut seed = Zeroizing::new([0u8; SEED_LEN]);
            rng.fill_bytes(seed.as_mut_slice());
            if let Ok(key) = RecoveryKey::from_seed(&seed) {
                return NewRecoveryKey {
                    seed,
                    public_key: key.public_key(),
                };
            }
        }
    }

    /// The 24 words, lowercase and separated by single spaces.
    pub fn words(&self) -> Zeroizing<String> {
        words::words_from_seed(&self.seed)
    }

    /// The content of the QR code: the same words in uppercase.
    pub fn qr_content(&self) -> Zeroizing<String> {
        let mut text = self.words();
        text.make_ascii_uppercase();
        text
    }

    /// The words as a QR code: the uppercase words in one alphanumeric segment
    /// at error correction level M, with no quiet zone.
    pub fn qr_code(&self) -> crate::device::QrCode {
        crate::device::qr_code_of(&self.qr_content())
    }

    /// The public key, which the device keeps and the song writer wraps for.
    pub fn public_key(&self) -> RecoveryPublicKey {
        self.public_key.clone()
    }
}

/// The owner's recovery public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryPublicKey(p256::PublicKey);

impl RecoveryPublicKey {
    /// Reads a 33-byte SEC1 compressed key. The prefix must be `02` or `03`
    /// and the key must be a point on the P-256 curve.
    pub fn from_compressed(bytes: &[u8]) -> Result<RecoveryPublicKey, RecoveryPublicKeyError> {
        if bytes.len() != COMPRESSED_LEN {
            return Err(RecoveryPublicKeyError::Length);
        }
        if bytes[0] != 0x02 && bytes[0] != 0x03 {
            return Err(RecoveryPublicKeyError::Key);
        }
        p256::PublicKey::from_sec1_bytes(bytes)
            .map(RecoveryPublicKey)
            .map_err(|_| RecoveryPublicKeyError::Key)
    }

    /// The 33-byte SEC1 compressed encoding.
    pub fn to_compressed(&self) -> [u8; COMPRESSED_LEN] {
        <[u8; COMPRESSED_LEN]>::try_from(self.0.to_encoded_point(true).as_bytes())
            .expect("a compressed point is 33 bytes")
    }
}

/// The two header fields that hold a sealed content key. Both are public
/// header bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryWrap {
    /// `recovery_enc`: the HPKE encapsulated key, an uncompressed point.
    pub enc: [u8; ENC_LEN],
    /// `recovery_sealed`: the encrypted content key and its tag.
    pub sealed: [u8; SEALED_LEN],
}

/// The HPKE `info`: the label, the song ID and the compressed recovery
/// public key.
fn info(song_id: &[u8; SONG_ID_LEN], recipient: &RecoveryPublicKey) -> [u8; INFO_LEN] {
    let mut info = [0u8; INFO_LEN];
    info[..WRAP_LABEL.len()].copy_from_slice(WRAP_LABEL);
    info[WRAP_LABEL.len()..WRAP_LABEL.len() + SONG_ID_LEN].copy_from_slice(song_id);
    info[WRAP_LABEL.len() + SONG_ID_LEN..].copy_from_slice(&recipient.to_compressed());
    info
}

impl RecoveryWrap {
    /// Seals the content key to the recovery public key for a song, with
    /// fresh randomness.
    pub fn seal(
        content_key: &ContentKey,
        recipient: &RecoveryPublicKey,
        song_id: &[u8; SONG_ID_LEN],
    ) -> RecoveryWrap {
        RecoveryWrap::seal_with_rng(content_key, recipient, song_id, &mut OsRng)
    }

    /// Seals with the given random source. HPKE draws its 32-byte ephemeral
    /// input from it. Only tests and the vectors fix it.
    pub(crate) fn seal_with_rng<R: RngCore + CryptoRng>(
        content_key: &ContentKey,
        recipient: &RecoveryPublicKey,
        song_id: &[u8; SONG_ID_LEN],
        rng: &mut R,
    ) -> RecoveryWrap {
        let point = recipient.0.to_encoded_point(false);
        let recipient_key = <Kem as hpke::Kem>::PublicKey::from_bytes(point.as_bytes())
            .expect("a valid public key is a valid HPKE public key");
        let (enc, sealed) = single_shot_seal::<AesGcm256, HkdfSha256, Kem, R>(
            &OpModeS::Base,
            &recipient_key,
            &info(song_id, recipient),
            content_key.expose(),
            &[],
            rng,
        )
        .expect("sealing to a valid public key succeeds");
        RecoveryWrap {
            enc: enc
                .to_bytes()
                .as_slice()
                .try_into()
                .expect("an encapsulated key is 65 bytes"),
            sealed: sealed
                .as_slice()
                .try_into()
                .expect("a sealed 32-byte key is 48 bytes"),
        }
    }

    /// Opens the wrap with the recovery private key. The content key is
    /// returned only when the open authenticates.
    pub fn open(
        &self,
        key: &RecoveryKey,
        song_id: &[u8; SONG_ID_LEN],
    ) -> Result<ContentKey, RecoveryWrapError> {
        if self.enc[0] != 0x04 || p256::PublicKey::from_sec1_bytes(&self.enc).is_err() {
            return Err(RecoveryWrapError::Enc);
        }
        let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&self.enc)
            .map_err(|_| RecoveryWrapError::Enc)?;
        let secret = Zeroizing::new(key.secret.to_bytes());
        let private_key = <Kem as hpke::Kem>::PrivateKey::from_bytes(secret.as_slice())
            .map_err(|_| RecoveryWrapError::Open)?;
        let plaintext = Zeroizing::new(
            single_shot_open::<AesGcm256, HkdfSha256, Kem>(
                &OpModeR::Base,
                &private_key,
                &enc,
                &info(song_id, &key.public_key()),
                &self.sealed,
                &[],
            )
            .map_err(|_| RecoveryWrapError::Open)?,
        );
        let bytes =
            <[u8; KEY_LEN]>::try_from(plaintext.as_slice()).map_err(|_| RecoveryWrapError::Open)?;
        Ok(ContentKey::from_bytes(bytes))
    }
}

/// Why a song could not be recovered. The reasons are checked in this order:
/// the words, the device code, the song file, the recovery wrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoverError {
    /// The recovery words were refused.
    Words(RecoveryWordsError),
    /// The device code was refused.
    DeviceCode(DeviceCodeError),
    /// The song file's header was refused.
    SongFile(SongFileError),
    /// The recovery wrap did not open. The wrong recovery key gives
    /// [`RecoveryWrapError::Open`].
    Wrap(RecoveryWrapError),
}

impl fmt::Display for RecoverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecoverError::Words(error) => error.fmt(f),
            RecoverError::DeviceCode(error) => error.fmt(f),
            RecoverError::SongFile(error) => error.fmt(f),
            RecoverError::Wrap(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for RecoverError {}

impl From<RecoveryWordsError> for RecoverError {
    fn from(error: RecoveryWordsError) -> RecoverError {
        RecoverError::Words(error)
    }
}

impl From<DeviceCodeError> for RecoverError {
    fn from(error: DeviceCodeError) -> RecoverError {
        RecoverError::DeviceCode(error)
    }
}

impl From<SongFileError> for RecoverError {
    fn from(error: SongFileError) -> RecoverError {
        RecoverError::SongFile(error)
    }
}

impl From<RecoveryWrapError> for RecoverError {
    fn from(error: RecoveryWrapError) -> RecoverError {
        RecoverError::Wrap(error)
    }
}

/// Opens a version 1 song file's recovery wrap with the recovery words, and
/// writes an access file for the device code. The file has one owner entry.
/// Only the song file's header is read.
pub fn recover_access(
    words: &str,
    song_file: &[u8],
    device_code: &str,
) -> Result<Vec<u8>, RecoverError> {
    let key = RecoveryKey::from_words(words)?;
    let device = PublicKey::parse_device_code(device_code)?;
    let header = v1::Header::parse(song_file)?;
    let song_id = header.song_id();
    let content_key = header.recovery_wrap().open(&key, &song_id)?;
    Ok(access::wrap(&content_key, &song_id, &device, Role::Owner))
}

/// A random source that gives one fixed 32-byte input, once: the `ikmE` of a
/// known-answer vector.
#[cfg(test)]
pub(crate) struct FixedIkm(pub(crate) [u8; 32], pub(crate) bool);

#[cfg(test)]
impl RngCore for FixedIkm {
    fn next_u32(&mut self) -> u32 {
        panic!("unexpected call");
    }
    fn next_u64(&mut self) -> u64 {
        panic!("unexpected call");
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        assert!(!self.1, "filled twice");
        assert_eq!(dest.len(), 32);
        self.1 = true;
        dest.copy_from_slice(&self.0);
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

#[cfg(test)]
impl CryptoRng for FixedIkm {}

/// The bytes of a hex string.
#[cfg(test)]
pub(crate) fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The hex string of `bytes`.
#[cfg(test)]
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The rows of the first table after `heading`, as cells with their
/// backticks removed.
#[cfg(test)]
pub(crate) fn table(doc: &str, heading: &str) -> Vec<Vec<String>> {
    let (_, section) = doc.split_once(heading).expect("the doc has the heading");
    section
        .lines()
        .skip_while(|line| !line.starts_with('|'))
        .take_while(|line| line.starts_with('|'))
        .skip(2)
        .map(|line| {
            line.trim_matches('|')
                .split('|')
                .map(|cell| cell.trim().trim_matches('`').to_owned())
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) const DEVICE_DOC: &str = include_str!("../../../docs/reference/device-access.md");
    const FORMAT_DOC: &str = include_str!("../../../docs/reference/song-file-format-v1.md");

    pub(super) fn key_rows() -> Vec<Vec<String>> {
        table(DEVICE_DOC, "### Recovery key\n\nEach row")
    }

    /// The value of the wrap vector's row named `item`.
    fn vector(item: &str) -> String {
        table(FORMAT_DOC, "### Recovery wrap vector")
            .into_iter()
            .find(|row| row[0] == item)
            .unwrap_or_else(|| panic!("the vector has a row {item}"))[1]
            .clone()
    }

    const SONG_ID: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    fn seed() -> [u8; 32] {
        unhex(&vector("Recovery seed"))
            .try_into()
            .expect("32 bytes")
    }

    fn content_key() -> ContentKey {
        ContentKey::from_bytes(unhex(&vector("Content key")).try_into().expect("32 bytes"))
    }

    fn ikm_e() -> [u8; 32] {
        unhex(&vector("Ephemeral input (`ikmE`)"))
            .try_into()
            .expect("32 bytes")
    }

    fn documented_wrap() -> RecoveryWrap {
        RecoveryWrap {
            enc: unhex(&vector("recovery_enc")).try_into().expect("65 bytes"),
            sealed: unhex(&vector("recovery_sealed"))
                .try_into()
                .expect("48 bytes"),
        }
    }

    fn recovery_key() -> RecoveryKey {
        RecoveryKey::from_seed(&seed()).expect("a valid seed")
    }

    fn fixed_seal() -> RecoveryWrap {
        RecoveryWrap::seal_with_rng(
            &content_key(),
            &recovery_key().public_key(),
            &SONG_ID,
            &mut FixedIkm(ikm_e(), false),
        )
    }

    #[test]
    fn the_doc_has_three_key_rows_and_the_wrap_vector_rows() {
        assert_eq!(key_rows().len(), 3);
        assert_eq!(table(FORMAT_DOC, "### Recovery wrap vector").len(), 8);
    }

    #[test]
    fn a_seed_gives_the_documented_key_pair() {
        for row in key_rows() {
            let seed: [u8; 32] = unhex(&row[0]).try_into().expect("32 bytes");
            let key = RecoveryKey::from_seed(&seed).expect("a valid seed");
            assert_eq!(hex(&key.secret.to_bytes()), row[1], "{}", row[0]);
            assert_eq!(hex(&key.public_key().to_compressed()), row[2], "{}", row[0]);
        }
    }

    #[test]
    fn the_wrap_vector_uses_the_documented_key_pair() {
        let row = &key_rows()[1];
        assert_eq!(row[0], vector("Recovery seed"));
        assert_eq!(row[2], vector("Recovery public key"));
    }

    #[test]
    fn a_zero_scalar_is_rejected() {
        // The group order n of P-256, as 48 big-endian bytes.
        let n: [u8; 48] = unhex(
            "00000000000000000000000000000000ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
        )
        .try_into()
        .expect("48 bytes");
        assert_eq!(
            RecoveryKey::from_scalar(crate::scalar::scalar_from_wide(&n)).err(),
            Some(RecoveryKeyError::ZeroScalar)
        );
    }

    #[test]
    fn the_wrap_vector_gives_the_documented_bytes() {
        let key = recovery_key();
        assert_eq!(hex(&info(&SONG_ID, &key.public_key())), vector("info"));
        let wrap = fixed_seal();
        assert_eq!(wrap, documented_wrap());
        assert_eq!(wrap.enc.len(), 65);
        assert_eq!(wrap.sealed.len(), 48);
    }

    #[test]
    fn the_documented_wrap_opens_to_the_content_key() {
        let key = documented_wrap()
            .open(&recovery_key(), &SONG_ID)
            .expect("the wrap opens");
        assert_eq!(key.expose(), content_key().expose());
        let expected: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        assert_eq!(key.expose(), &expected);
    }

    #[test]
    fn the_ephemeral_input_is_the_rfc_9180_ikm_e() {
        let (_, public) = <Kem as hpke::Kem>::derive_keypair(&ikm_e());
        assert_eq!(fixed_seal().enc.as_slice(), public.to_bytes().as_slice());
    }

    #[test]
    fn a_changed_byte_of_sealed_fails_the_open() {
        for offset in [0, 31, 32, 47] {
            let mut wrap = documented_wrap();
            wrap.sealed[offset] ^= 1;
            assert_eq!(
                wrap.open(&recovery_key(), &SONG_ID).err(),
                Some(RecoveryWrapError::Open),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn another_valid_enc_fails_the_open() {
        let (_, public) = <Kem as hpke::Kem>::derive_keypair(&[9; 32]);
        let mut wrap = documented_wrap();
        wrap.enc = public.to_bytes().as_slice().try_into().expect("65 bytes");
        assert_eq!(
            wrap.open(&recovery_key(), &SONG_ID).err(),
            Some(RecoveryWrapError::Open)
        );
    }

    #[test]
    fn a_wrong_song_id_fails_the_open() {
        let mut other = SONG_ID;
        other[15] = 0x10;
        assert_eq!(
            documented_wrap().open(&recovery_key(), &other).err(),
            Some(RecoveryWrapError::Open)
        );
    }

    #[test]
    fn a_wrong_recovery_key_fails_the_open() {
        let other = RecoveryKey::from_seed(&[0; 32]).expect("a valid seed");
        assert_eq!(
            documented_wrap().open(&other, &SONG_ID).err(),
            Some(RecoveryWrapError::Open)
        );
    }

    #[test]
    fn an_enc_that_is_not_a_valid_point_is_refused() {
        // The field prime p of P-256.
        let p = unhex("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
        let valid = documented_wrap().enc;
        let mut cases: Vec<(&str, [u8; 65])> = Vec::new();
        for prefix in [0x02, 0x03, 0x00] {
            let mut enc = valid;
            enc[0] = prefix;
            cases.push(("prefix", enc));
        }
        let mut enc = valid;
        enc[1..33].copy_from_slice(&p);
        cases.push(("x = p", enc));
        let mut enc = valid;
        enc[33..].copy_from_slice(&p);
        cases.push(("y = p", enc));
        let mut enc = [0u8; 65];
        enc[0] = 0x04;
        enc[32] = 1;
        enc[64] = 1;
        cases.push(("(1, 1)", enc));
        for (name, enc) in cases {
            let wrap = RecoveryWrap {
                enc,
                sealed: documented_wrap().sealed,
            };
            assert_eq!(
                wrap.open(&recovery_key(), &SONG_ID).err(),
                Some(RecoveryWrapError::Enc),
                "{name}"
            );
        }
    }

    #[test]
    fn a_random_seal_opens() {
        let key = recovery_key();
        let content = ContentKey::generate();
        let wrap = RecoveryWrap::seal(&content, &key.public_key(), &SONG_ID);
        let opened = wrap.open(&key, &SONG_ID).expect("the wrap opens");
        assert_eq!(opened.expose(), content.expose());
        let again = RecoveryWrap::seal(&content, &key.public_key(), &SONG_ID);
        assert_ne!(wrap.enc, again.enc);
    }

    #[test]
    fn the_documented_public_keys_parse_and_round_trip() {
        for row in key_rows() {
            let compressed = unhex(&row[2]);
            let key = RecoveryPublicKey::from_compressed(&compressed).expect("a valid key");
            assert_eq!(key.to_compressed().to_vec(), compressed);
        }
    }

    #[test]
    fn an_invalid_public_key_is_refused_with_its_reason() {
        let valid = unhex(&key_rows()[0][2]);
        for len in [0, 32, 34] {
            let bytes = vec![valid[0]; len];
            assert_eq!(
                RecoveryPublicKey::from_compressed(&bytes),
                Err(RecoveryPublicKeyError::Length),
                "{len} bytes"
            );
        }
        for prefix in [0x00, 0x04] {
            let mut bytes = valid.clone();
            bytes[0] = prefix;
            assert_eq!(
                RecoveryPublicKey::from_compressed(&bytes),
                Err(RecoveryPublicKeyError::Key),
                "prefix {prefix:02x}"
            );
        }
        let mut p = vec![0x02];
        p.extend(unhex(
            "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
        ));
        let mut off_curve = vec![0x02];
        off_curve.extend([0u8; 31]);
        off_curve.push(1);
        for bytes in [p, off_curve] {
            assert_eq!(
                RecoveryPublicKey::from_compressed(&bytes),
                Err(RecoveryPublicKeyError::Key)
            );
        }
    }

    #[test]
    fn debug_and_error_text_hold_no_private_scalar() {
        let scalars: Vec<String> = key_rows().into_iter().map(|row| row[1].clone()).collect();
        for row in key_rows() {
            let seed: [u8; 32] = unhex(&row[0]).try_into().expect("32 bytes");
            let key = RecoveryKey::from_seed(&seed).expect("a valid seed");
            let text = format!("{key:?}");
            assert_eq!(text, "RecoveryKey { .. }");
            assert!(!text.contains(&row[1]));
            assert!(!format!("{:?}", key.public_key()).contains(&row[1]));
        }
        let texts = [
            format!("{0:?} {0}", RecoveryKeyError::ZeroScalar),
            format!("{0:?} {0}", RecoveryWrapError::Enc),
            format!("{0:?} {0}", RecoveryWrapError::Open),
            format!("{0:?} {0}", RecoveryPublicKeyError::Length),
            format!("{0:?} {0}", RecoveryPublicKeyError::Key),
        ];
        for text in texts {
            for scalar in &scalars {
                assert!(!text.contains(scalar));
            }
        }
    }

    fn example_file(recovery: &RecoveryPublicKey, content: &ContentKey) -> Vec<u8> {
        v1::write(
            &crate::song_file::tests::example_song(),
            content,
            recovery,
            v1::Salt::generate(),
        )
        .expect("the example song is written")
    }

    #[test]
    fn the_qr_code_decodes_to_the_uppercase_words_at_level_m() {
        let new = NewRecoveryKey::generate_with_rng(&mut FixedIkm(seed(), false));
        let qr = new.qr_code();
        assert_eq!(qr.dark.len(), qr.size * qr.size);
        let (meta, text) = crate::device::tests::read_qr(&qr);
        assert_eq!(text, new.qr_content().as_str());
        assert_eq!(text, new.words().to_uppercase());
        // rqrr numbers the levels as the format bits do: M is 0.
        assert_eq!(meta.ecc_level, 0);
        assert!((5..=8).contains(&meta.version.0), "{}", meta.version.0);
        assert_eq!(qr.size, 17 + 4 * meta.version.0);
    }

    #[test]
    fn two_new_keys_give_different_words() {
        let (a, b) = (NewRecoveryKey::generate(), NewRecoveryKey::generate());
        assert_ne!(*a.words(), *b.words());
        assert_ne!(a.public_key(), b.public_key());
        assert_eq!(a.words().split(' ').count(), 24);
    }

    #[test]
    fn a_new_key_gives_its_words_qr_content_and_public_key() {
        let new = NewRecoveryKey::generate_with_rng(&mut FixedIkm(seed(), false));
        assert_eq!(new.words().as_str(), word_rows_second());
        assert_eq!(*new.qr_content(), new.words().to_uppercase());
        let key = RecoveryKey::from_words(&new.words()).expect("valid words");
        assert_eq!(key.public_key(), new.public_key());
        let scanned = RecoveryKey::from_words(&new.qr_content()).expect("valid QR content");
        assert_eq!(scanned.public_key(), new.public_key());
        assert_eq!(hex(&new.public_key().to_compressed()), key_rows()[1][2]);
    }

    fn word_rows_second() -> String {
        table(DEVICE_DOC, "Each row of this table gives a seed")[1][1].clone()
    }

    #[test]
    fn a_song_made_with_the_public_key_is_recovered_on_a_new_device() {
        let new = NewRecoveryKey::generate();
        let content = ContentKey::generate();
        let file = example_file(&new.public_key(), &content);
        let device = crate::device::DeviceKey::from_prf_output(&[0x11; 32]).expect("a device key");
        let code = device.public_key().device_code();
        let access_file = recover_access(&new.words(), &file, &code).expect("recovery works");
        let song_id = v1::Header::parse(&file).expect("a header").song_id();
        let opened = access::open(&access_file, &device, &song_id).expect("the device opens it");
        assert_eq!(opened.role, Role::Owner);
        assert_eq!(opened.content_key.expose(), content.expose());
        let song = v1::read(&file, &opened.content_key).expect("the song is read");
        assert_eq!(song, crate::song_file::tests::example_song());
        // The QR content recovers the same way.
        recover_access(&new.qr_content(), &file, &code).expect("QR content works");
    }

    #[test]
    fn another_recovery_keys_words_are_refused() {
        let (new, other) = (NewRecoveryKey::generate(), NewRecoveryKey::generate());
        let file = example_file(&new.public_key(), &ContentKey::generate());
        let code = crate::device::DeviceKey::from_prf_output(&[0x11; 32])
            .expect("a device key")
            .public_key()
            .device_code();
        assert_eq!(
            recover_access(&other.words(), &file, &code),
            Err(RecoverError::Wrap(RecoveryWrapError::Open))
        );
    }

    #[test]
    fn recovery_checks_the_words_the_device_code_and_the_file_in_that_order() {
        let new = NewRecoveryKey::generate();
        let file = example_file(&new.public_key(), &ContentKey::generate());
        let code = crate::device::DeviceKey::from_prf_output(&[0x11; 32])
            .expect("a device key")
            .public_key()
            .device_code();
        let words = new.words();
        assert_eq!(
            recover_access("abandon", &file[..10], "nonsense"),
            Err(RecoverError::Words(RecoveryWordsError::Count))
        );
        assert!(matches!(
            recover_access(&words, &file[..10], "nonsense"),
            Err(RecoverError::DeviceCode(_))
        ));
        assert!(matches!(
            recover_access(&words, &file[..10], &code),
            Err(RecoverError::SongFile(SongFileError::HeaderTooShort { .. }))
        ));
        // The header alone is enough: the 177 bytes before the index.
        assert!(recover_access(&words, &file[..177], &code).is_ok());
    }

    #[test]
    fn debug_and_error_text_hold_no_words() {
        // A fixed key, so the words are the same on every run.
        let new = NewRecoveryKey::generate_with_rng(&mut FixedIkm(seed(), false));
        let words = new.words();
        assert_eq!(format!("{new:?}"), "NewRecoveryKey { .. }");
        let key = RecoveryKey::from_words(&words).expect("valid words");
        assert_eq!(format!("{key:?}"), "RecoveryKey { .. }");
        let file = example_file(&new.public_key(), &ContentKey::generate());
        let errors = [
            RecoverError::Words(RecoveryWordsError::Count),
            RecoverError::Words(RecoveryWordsError::Word),
            RecoverError::Words(RecoveryWordsError::Checksum),
            RecoverError::Wrap(RecoveryWrapError::Open),
            recover_access(&words, &file[..10], "nonsense").expect_err("refused"),
            recover_access(&words, &file, "nonsense").expect_err("refused"),
        ];
        // The fixed messages, which do not change with the input.
        let messages: Vec<String> = errors.iter().take(4).map(|e| e.to_string()).collect();
        assert_eq!(
            messages,
            [
                "the recovery key does not have 24 words",
                "the recovery key has a word that is not in the list",
                "the recovery key has a bad checksum",
                "the recovery wrap did not open",
            ]
        );
        let mut texts: Vec<String> = errors.iter().map(|e| format!("{e:?} {e}")).collect();
        texts.push(format!("{:?}", new.public_key()));
        let typed: Vec<&str> = words.split(' ').collect();
        assert_eq!(typed.len(), 24);
        for text in texts {
            for part in text.split(|c: char| !c.is_ascii_alphanumeric()) {
                assert!(!typed.contains(&part), "{text}");
            }
        }
    }
}
