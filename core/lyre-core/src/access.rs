//! The access file: one device's wrapped content keys.
//!
//! The bytes are in `docs/reference/device-access.md#access-file`. [`wrap`]
//! writes a file with one entry for one device. [`open`] opens a file with
//! this device's key, for one song. [`share`] turns an owner's entry into a
//! recipient's file. The content key comes back only as a
//! [`ContentKey`] handle, together with the role. No function returns key
//! bytes, and no error names any.

use std::fmt;

use hpke::aead::AesGcm256;
use hpke::kdf::HkdfSha256;
use hpke::kem::DhP256HkdfSha256;
use hpke::{Deserializable, OpModeR, OpModeS, Serializable, single_shot_open, single_shot_seal};
use rand_core::{CryptoRng, OsRng, RngCore};
use zeroize::Zeroizing;

use crate::content_key::{ContentKey, KEY_LEN};
use crate::device::{DeviceKey, PublicKey};
use crate::recovery::{ENC_LEN, SEALED_LEN};

/// The first bytes of an access file.
const MAGIC: [u8; 8] = [0x89, 0x4C, 0x4B, 0x45, 0x59, 0x0D, 0x0A, 0x1A];

/// The access file version.
const VERSION: u16 = 1;

/// The size of the header, in bytes.
const HEADER_LEN: usize = 49;

/// The size of one entry, in bytes.
const ENTRY_LEN: usize = 130;

/// The most entries a file may hold.
const MAX_ENTRIES: usize = 16_384;

/// The size of a song ID, in bytes.
const SONG_ID_LEN: usize = 16;

/// The size of a compressed P-256 public key, in bytes.
const COMPRESSED_LEN: usize = 33;

/// The start of the HPKE `info`.
const LABEL: &[u8] = b"lyre/v1/access";

/// The size of the HPKE `info`, in bytes.
const INFO_LEN: usize = LABEL.len() + SONG_ID_LEN + COMPRESSED_LEN + 1;

type Kem = DhP256HkdfSha256;

/// Whether the song's owner or a person it was shared with holds the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Owner,
    Recipient,
}

impl Role {
    fn to_byte(self) -> u8 {
        match self {
            Role::Owner => 1,
            Role::Recipient => 2,
        }
    }

    fn from_byte(byte: u8) -> Option<Role> {
        match byte {
            1 => Some(Role::Owner),
            2 => Some(Role::Recipient),
            _ => None,
        }
    }
}

/// Why an access file was refused. Each reason is one row of the
/// rejections table in the reference. Every authentication failure gives
/// [`Open`](AccessFileError::Open).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessFileError {
    /// The magic does not match.
    Magic,
    /// The version is not 1.
    Version,
    /// The reserved field is not 0.
    Reserved,
    /// The entry count is not from 1 through 16,384.
    EntryCount,
    /// The file size is not `49 + 130 × entry_count`.
    Size,
    /// The header key is not a compressed point on the curve.
    DeviceKey,
    /// An entry's role is not 1 or 2.
    Role,
    /// The song IDs are not strictly increasing.
    Order,
    /// An entry's `enc` is not a valid uncompressed point.
    Enc,
    /// The file is for another device.
    OtherDevice,
    /// The file has no entry for the song.
    OtherSong,
    /// The entry did not open.
    Open,
}

impl fmt::Display for AccessFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            AccessFileError::Magic => "the access file has the wrong magic",
            AccessFileError::Version => "the access file has an unknown version",
            AccessFileError::Reserved => "the access file has a bad reserved field",
            AccessFileError::EntryCount => "the access file has a bad entry count",
            AccessFileError::Size => "the access file has the wrong size",
            AccessFileError::DeviceKey => "the access file holds no valid device key",
            AccessFileError::Role => "an access file entry has a bad role",
            AccessFileError::Order => "the access file entries are not in order",
            AccessFileError::Enc => "an access file entry holds no valid point",
            AccessFileError::OtherDevice => "the access file is for another device",
            AccessFileError::OtherSong => "the access file has no entry for this song",
            AccessFileError::Open => "the access file entry did not open",
        };
        write!(f, "{reason}")
    }
}

impl std::error::Error for AccessFileError {}

/// What an access file gives for one song. The content key is a handle: its
/// bytes cannot be read outside the crate.
///
/// ```
/// use lyre_core::access::{Role, open, wrap};
/// use lyre_core::content_key::ContentKey;
/// use lyre_core::device::DeviceKey;
///
/// let device = DeviceKey::from_prf_output(&[7; 32]).unwrap();
/// let file = wrap(
///     &ContentKey::from_bytes([0x40; 32]),
///     &[1; 16],
///     &device.public_key(),
///     Role::Owner,
/// );
/// let access = open(&file, &device, &[1; 16]).unwrap();
/// assert_eq!(access.role, Role::Owner);
/// ```
///
/// The key's bytes are not reachable:
///
/// ```compile_fail
/// use lyre_core::access::{Role, open, wrap};
/// use lyre_core::content_key::ContentKey;
/// use lyre_core::device::DeviceKey;
///
/// let device = DeviceKey::from_prf_output(&[7; 32]).unwrap();
/// let file = wrap(
///     &ContentKey::from_bytes([0x40; 32]),
///     &[1; 16],
///     &device.public_key(),
///     Role::Owner,
/// );
/// let access = open(&file, &device, &[1; 16]).unwrap();
/// let _ = access.content_key.expose();
/// ```
///
/// ```compile_fail
/// use lyre_core::access::{Role, open, wrap};
/// use lyre_core::content_key::ContentKey;
/// use lyre_core::device::DeviceKey;
///
/// let device = DeviceKey::from_prf_output(&[7; 32]).unwrap();
/// let file = wrap(
///     &ContentKey::from_bytes([0x40; 32]),
///     &[1; 16],
///     &device.public_key(),
///     Role::Owner,
/// );
/// let access = open(&file, &device, &[1; 16]).unwrap();
/// let _: [u8; 32] = access.content_key.to_bytes();
/// ```
#[derive(Debug)]
pub struct Access {
    pub content_key: ContentKey,
    pub role: Role,
}

/// The HPKE `info`: the label, the song ID, the compressed device key and
/// the role byte.
fn info(song_id: &[u8; SONG_ID_LEN], device: &[u8; COMPRESSED_LEN], role: u8) -> [u8; INFO_LEN] {
    let mut info = [0u8; INFO_LEN];
    info[..LABEL.len()].copy_from_slice(LABEL);
    info[LABEL.len()..LABEL.len() + SONG_ID_LEN].copy_from_slice(song_id);
    info[LABEL.len() + SONG_ID_LEN..INFO_LEN - 1].copy_from_slice(device);
    info[INFO_LEN - 1] = role;
    info
}

/// Wraps a song's content key for a device. The file holds one entry.
pub fn wrap(
    content_key: &ContentKey,
    song_id: &[u8; SONG_ID_LEN],
    device: &PublicKey,
    role: Role,
) -> Vec<u8> {
    wrap_with_rng(content_key, song_id, device, role, &mut OsRng)
}

/// [`wrap`] with the given random source. HPKE draws its 32-byte ephemeral
/// input from it. Only tests and the vectors fix it.
pub(crate) fn wrap_with_rng<R: RngCore + CryptoRng>(
    content_key: &ContentKey,
    song_id: &[u8; SONG_ID_LEN],
    device: &PublicKey,
    role: Role,
    rng: &mut R,
) -> Vec<u8> {
    let recipient = <Kem as hpke::Kem>::PublicKey::from_bytes(&device.to_uncompressed())
        .expect("a valid public key is a valid HPKE public key");
    let compressed = device.to_compressed();
    let (enc, sealed) = single_shot_seal::<AesGcm256, HkdfSha256, Kem, R>(
        &OpModeS::Base,
        &recipient,
        &info(song_id, &compressed, role.to_byte()),
        content_key.expose(),
        &[],
        rng,
    )
    .expect("sealing to a valid public key succeeds");
    let enc = enc.to_bytes();
    debug_assert_eq!(enc.len(), ENC_LEN);
    debug_assert_eq!(sealed.len(), SEALED_LEN);
    let mut file = Vec::with_capacity(HEADER_LEN + ENTRY_LEN);
    file.extend_from_slice(&MAGIC);
    file.extend_from_slice(&VERSION.to_le_bytes());
    file.extend_from_slice(&0u16.to_le_bytes());
    file.extend_from_slice(&1u32.to_le_bytes());
    file.extend_from_slice(&compressed);
    file.extend_from_slice(song_id);
    file.push(role.to_byte());
    file.extend_from_slice(enc.as_slice());
    file.extend_from_slice(&sealed);
    file
}

/// Opens an access file for one song with this device's key. The whole file
/// is checked first, with nothing allocated by its entry count. Then the
/// song's entry is opened, and only a successful open gives the content key
/// and the role.
pub fn open(
    file: &[u8],
    device_key: &DeviceKey,
    song_id: &[u8; SONG_ID_LEN],
) -> Result<Access, AccessFileError> {
    if file.len() < HEADER_LEN {
        return Err(AccessFileError::Size);
    }
    if file[..8] != MAGIC {
        return Err(AccessFileError::Magic);
    }
    if u16::from_le_bytes([file[8], file[9]]) != VERSION {
        return Err(AccessFileError::Version);
    }
    if file[10..12] != [0, 0] {
        return Err(AccessFileError::Reserved);
    }
    let count = u32::from_le_bytes([file[12], file[13], file[14], file[15]]) as usize;
    if !(1..=MAX_ENTRIES).contains(&count) {
        return Err(AccessFileError::EntryCount);
    }
    if file.len() != HEADER_LEN + ENTRY_LEN * count {
        return Err(AccessFileError::Size);
    }
    let header_key = &file[16..HEADER_LEN];
    if !matches!(header_key[0], 0x02 | 0x03)
        || p256::PublicKey::from_sec1_bytes(header_key).is_err()
    {
        return Err(AccessFileError::DeviceKey);
    }
    let mut found: Option<&[u8]> = None;
    let mut previous: Option<&[u8]> = None;
    // The size check leaves no remainder.
    let (entries, _) = file[HEADER_LEN..].as_chunks::<ENTRY_LEN>();
    for entry in entries {
        let entry_song = &entry[..SONG_ID_LEN];
        if Role::from_byte(entry[16]).is_none() {
            return Err(AccessFileError::Role);
        }
        if previous.is_some_and(|before| before >= entry_song) {
            return Err(AccessFileError::Order);
        }
        previous = Some(entry_song);
        let enc = &entry[17..17 + ENC_LEN];
        if enc[0] != 0x04 || p256::PublicKey::from_sec1_bytes(enc).is_err() {
            return Err(AccessFileError::Enc);
        }
        if entry_song == song_id {
            found = Some(entry);
        }
    }
    let device = device_key.public_key().to_compressed();
    if header_key != device {
        return Err(AccessFileError::OtherDevice);
    }
    let entry = found.ok_or(AccessFileError::OtherSong)?;
    let role = Role::from_byte(entry[16]).ok_or(AccessFileError::Role)?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&entry[17..17 + ENC_LEN])
        .map_err(|_| AccessFileError::Enc)?;
    let secret = device_key.secret_bytes();
    let private_key = <Kem as hpke::Kem>::PrivateKey::from_bytes(secret.as_slice())
        .map_err(|_| AccessFileError::Open)?;
    let plaintext = Zeroizing::new(
        single_shot_open::<AesGcm256, HkdfSha256, Kem>(
            &OpModeR::Base,
            &private_key,
            &enc,
            &info(song_id, &device, role.to_byte()),
            &entry[17 + ENC_LEN..],
            &[],
        )
        .map_err(|_| AccessFileError::Open)?,
    );
    let bytes =
        <[u8; KEY_LEN]>::try_from(plaintext.as_slice()).map_err(|_| AccessFileError::Open)?;
    Ok(Access {
        content_key: ContentKey::from_bytes(bytes),
        role,
    })
}

/// Why a song could not be shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareError {
    /// The owner's access file was refused.
    Access(AccessFileError),
    /// The access file holds a recipient entry. Only the owner shares (D13).
    NotOwner,
}

impl fmt::Display for ShareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShareError::Access(error) => error.fmt(f),
            ShareError::NotOwner => write!(f, "only the owner can share this song"),
        }
    }
}

impl std::error::Error for ShareError {}

impl From<AccessFileError> for ShareError {
    fn from(error: AccessFileError) -> ShareError {
        ShareError::Access(error)
    }
}

/// Shares a song with another device. The owner's access file is opened with
/// the owner's key, and the song's content key is wrapped again for the
/// recipient with the recipient role. A recipient's file is refused.
pub fn share(
    owner_file: &[u8],
    device_key: &DeviceKey,
    song_id: &[u8; SONG_ID_LEN],
    recipient: &PublicKey,
) -> Result<Vec<u8>, ShareError> {
    let access = open(owner_file, device_key, song_id)?;
    if access.role != Role::Owner {
        return Err(ShareError::NotOwner);
    }
    Ok(wrap(
        &access.content_key,
        song_id,
        recipient,
        Role::Recipient,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::{FixedIkm, RecoveryKey, hex, table, unhex};
    use crate::song_file::tests::example_song;
    use crate::song_file::v1;

    const DOC: &str = include_str!("../../../docs/reference/device-access.md");

    /// The value of the vector's row named `item`.
    fn vector(item: &str) -> String {
        table(DOC, "### Access file\n\nThe vector wraps")
            .into_iter()
            .find(|row| row[0] == item)
            .unwrap_or_else(|| panic!("the vector has a row {item}"))[1]
            .clone()
    }

    fn bytes<const N: usize>(text: &str) -> [u8; N] {
        unhex(text).try_into().expect("the right length")
    }

    fn device_key() -> DeviceKey {
        DeviceKey::from_prf_output(&unhex(&vector("Device PRF output"))).expect("a valid key")
    }

    /// The device key of the PRF output of `byte` repeated.
    fn other_key(byte: u8) -> DeviceKey {
        DeviceKey::from_prf_output(&[byte; 32]).expect("a valid key")
    }

    fn song_id() -> [u8; 16] {
        bytes(&vector("song_id"))
    }

    fn content_key() -> ContentKey {
        ContentKey::from_bytes(bytes(&vector("Content key")))
    }

    fn ikm_e() -> [u8; 32] {
        bytes(&vector("Ephemeral input (`ikmE`)"))
    }

    /// The documented access file.
    fn documented() -> Vec<u8> {
        let (_, after) = DOC
            .split_once("The whole 179-byte access file")
            .expect("the doc has the file");
        let (_, block) = after.split_once("```text\n").expect("a text block");
        let (text, _) = block.split_once("```").expect("the block ends");
        unhex(&text.split_whitespace().collect::<String>())
    }

    fn fixed_wrap() -> Vec<u8> {
        wrap_with_rng(
            &content_key(),
            &song_id(),
            &device_key().public_key(),
            Role::Owner,
            &mut FixedIkm(ikm_e(), false),
        )
    }

    fn invalid_rows() -> Vec<Vec<String>> {
        table(DOC, "Each invalid row changes the file above")
    }

    /// The prime field modulus of P-256.
    fn p() -> Vec<u8> {
        unhex("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff")
    }

    /// The documented file's entry with its song ID changed.
    fn entry_for(song: &[u8; 16]) -> Vec<u8> {
        let mut entry = documented()[HEADER_LEN..].to_vec();
        entry[..16].copy_from_slice(song);
        entry
    }

    /// The documented file changed as the invalid row `case` says.
    fn variant(case: &str) -> Vec<u8> {
        let mut file = documented();
        match case {
            "Bad magic" => file[0] = 0x88,
            "Version 2" => file[8..10].copy_from_slice(&[2, 0]),
            "Reserved set" => file[10..12].copy_from_slice(&[1, 0]),
            "Entry count 0" => file[12..16].copy_from_slice(&[0, 0, 0, 0]),
            "Entry count 16,385" => file[12..16].copy_from_slice(&[1, 0x40, 0, 0]),
            "Header too short" => file.truncate(48),
            "One byte missing" => {
                file.pop();
            }
            "One byte added" => file.push(0),
            "Count 2, size of 1" => file[12..16].copy_from_slice(&[2, 0, 0, 0]),
            "Header key prefix 04" => file[16] = 0x04,
            "Header key x = p" => {
                file[16] = 0x02;
                file[17..49].copy_from_slice(&p());
            }
            "Role 0" => file[65] = 0,
            "Role 3" => file[65] = 3,
            "Enc prefix 02" => file[66] = 0x02,
            "Enc x = p" => file[67..99].copy_from_slice(&p()),
            "Duplicate song ID" => {
                let entry = file[HEADER_LEN..].to_vec();
                file.extend_from_slice(&entry);
                file[12] = 2;
            }
            "Song IDs out of order" => {
                let mut small = entry_for(&[0; 16]);
                small[16..].copy_from_slice(&file[HEADER_LEN + 16..]);
                file.truncate(HEADER_LEN);
                file.extend_from_slice(&entry_for(&[1; 16]));
                file.extend_from_slice(&small);
                file[12] = 2;
            }
            _ => panic!("no change for the row {case}"),
        }
        file
    }

    fn open_documented(file: &[u8]) -> Result<Access, AccessFileError> {
        open(file, &device_key(), &song_id())
    }

    #[test]
    fn the_doc_has_the_vector_and_the_invalid_rows() {
        assert_eq!(table(DOC, "### Access file\n\nThe vector wraps").len(), 10);
        assert_eq!(documented().len(), 179);
        assert_eq!(invalid_rows().len(), 17);
    }

    #[test]
    fn the_vector_uses_the_documented_device_key() {
        let key = device_key();
        let web = &table(DOC, "### Web device key\n\nEach row")[1];
        assert_eq!(web[0], vector("Device PRF output"));
        assert_eq!(hex(&key.public_key().to_compressed()), web[2]);
        assert_eq!(
            hex(&key.public_key().to_compressed()),
            vector("Device public key")
        );
        assert_eq!(key.public_key().device_code(), vector("Device code"));
        assert_eq!(vector("role"), "01");
    }

    #[test]
    fn the_info_is_the_label_the_song_the_device_and_the_role() {
        let mut expected = b"lyre/v1/access".to_vec();
        expected.extend_from_slice(&unhex("000102030405060708090a0b0c0d0e0f"));
        expected.extend_from_slice(&unhex(&vector("Device public key")));
        expected.push(1);
        assert_eq!(expected.len(), 64);
        assert_eq!(hex(&expected), vector("info"));
        let compressed = device_key().public_key().to_compressed();
        assert_eq!(info(&song_id(), &compressed, 1).as_slice(), expected);
    }

    #[test]
    fn the_fixed_inputs_give_the_documented_file() {
        let file = fixed_wrap();
        assert_eq!(file, documented());
        assert_eq!(file.len(), 179);
        assert_eq!(hex(&file[66..131]), vector("enc"));
        assert_eq!(hex(&file[131..]), vector("ct"));
        assert_eq!(file[..8], MAGIC);
        assert_eq!(file[8..16], [1, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(hex(&file[16..49]), vector("Device public key"));
        assert_eq!(hex(&file[49..65]), vector("song_id"));
    }

    #[test]
    fn the_ephemeral_input_is_the_rfc_9180_ikm_e() {
        let (_, public) = <Kem as hpke::Kem>::derive_keypair(&ikm_e());
        assert_eq!(fixed_wrap()[66..131], public.to_bytes().as_slice()[..]);
    }

    #[test]
    fn the_documented_file_opens_to_the_content_key_and_the_owner() {
        let access = open_documented(&documented()).expect("the file opens");
        assert_eq!(access.role, Role::Owner);
        assert_eq!(access.content_key.expose(), content_key().expose());
        let expected: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        assert_eq!(access.content_key.expose(), &expected);
    }

    #[test]
    fn a_random_wrap_opens_for_either_role() {
        let device = device_key();
        let key = ContentKey::generate();
        for role in [Role::Owner, Role::Recipient] {
            let file = wrap(&key, &song_id(), &device.public_key(), role);
            let access = open(&file, &device, &song_id()).expect("the file opens");
            assert_eq!(access.role, role);
            assert_eq!(access.content_key.expose(), key.expose());
            let again = wrap(&key, &song_id(), &device.public_key(), role);
            assert_ne!(file[66..131], again[66..131]);
        }
    }

    #[test]
    fn every_invalid_row_is_refused_with_its_reason() {
        for row in invalid_rows() {
            let file = variant(&row[0]);
            let error = open_documented(&file).expect_err(&row[0]);
            assert_eq!(format!("{error:?}"), row[2], "{}", row[0]);
        }
    }

    #[test]
    fn a_file_shorter_than_the_header_is_refused_whatever_it_holds() {
        for len in [0, 1, 8, 48] {
            let mut file = documented();
            file.truncate(len);
            assert_eq!(open_documented(&file).err(), Some(AccessFileError::Size));
        }
    }

    #[test]
    fn a_huge_entry_count_is_refused_before_any_entry_is_read() {
        let mut file = documented();
        file[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            open_documented(&file).err(),
            Some(AccessFileError::EntryCount)
        );
        // The largest allowed count, with one entry's bytes, is a size error.
        file[12..16].copy_from_slice(&(MAX_ENTRIES as u32).to_le_bytes());
        assert_eq!(open_documented(&file).err(), Some(AccessFileError::Size));
    }

    #[test]
    fn a_file_for_another_song_is_refused() {
        let mut other = song_id();
        other[15] ^= 1;
        assert_eq!(
            open(&documented(), &device_key(), &other).err(),
            Some(AccessFileError::OtherSong)
        );
    }

    #[test]
    fn a_file_for_another_device_is_refused() {
        for byte in [0x00, 0xff] {
            assert_eq!(
                open(&documented(), &other_key(byte), &song_id()).err(),
                Some(AccessFileError::OtherDevice)
            );
        }
    }

    #[test]
    fn a_changed_byte_of_the_ciphertext_fails_the_open() {
        for offset in [131, 150, 162, 178] {
            let mut file = documented();
            file[offset] ^= 1;
            assert_eq!(
                open_documented(&file).err(),
                Some(AccessFileError::Open),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn a_changed_byte_of_the_song_id_fails_the_open_for_that_song_id() {
        for offset in 49..65 {
            let mut file = documented();
            file[offset] ^= 1;
            let changed: [u8; 16] = file[49..65].try_into().expect("16 bytes");
            assert_eq!(
                open(&file, &device_key(), &changed).err(),
                Some(AccessFileError::Open),
                "offset {offset}"
            );
            assert_eq!(
                open_documented(&file).err(),
                Some(AccessFileError::OtherSong),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn a_changed_role_fails_the_open() {
        let mut file = documented();
        file[65] = 2;
        assert_eq!(open_documented(&file).err(), Some(AccessFileError::Open));
    }

    #[test]
    fn a_changed_byte_of_enc_leaves_the_curve_or_fails_the_open() {
        for offset in [67, 80, 98, 99, 120, 130] {
            let mut file = documented();
            file[offset] ^= 1;
            assert_eq!(
                open_documented(&file).err(),
                Some(AccessFileError::Enc),
                "offset {offset}"
            );
        }
        let (_, public) = <Kem as hpke::Kem>::derive_keypair(&[9; 32]);
        let mut file = documented();
        file[66..131].copy_from_slice(public.to_bytes().as_slice());
        assert_eq!(open_documented(&file).err(), Some(AccessFileError::Open));
    }

    #[test]
    fn a_header_key_swapped_for_another_devices_key_fails_the_open() {
        let other = other_key(0x00);
        assert_eq!(
            hex(&other.public_key().to_compressed()),
            table(DOC, "### Web device key\n\nEach row")[0][2]
        );
        let mut file = documented();
        file[16..49].copy_from_slice(&other.public_key().to_compressed());
        assert_eq!(
            open(&file, &other, &song_id()).err(),
            Some(AccessFileError::Open)
        );
        assert_eq!(
            open_documented(&file).err(),
            Some(AccessFileError::OtherDevice)
        );
    }

    #[test]
    fn a_two_entry_file_opens_either_song() {
        let device = device_key();
        let first = ContentKey::from_bytes([1; 32]);
        let second = ContentKey::from_bytes([2; 32]);
        let first_id = [3; 16];
        let second_id = [9; 16];
        let one = wrap(&first, &first_id, &device.public_key(), Role::Owner);
        let two = wrap(&second, &second_id, &device.public_key(), Role::Recipient);
        let mut file = one.clone();
        file.extend_from_slice(&two[HEADER_LEN..]);
        file[12] = 2;
        let access = open(&file, &device, &first_id).expect("the first opens");
        assert_eq!(
            (access.role, access.content_key.expose()),
            (Role::Owner, first.expose())
        );
        let access = open(&file, &device, &second_id).expect("the second opens");
        assert_eq!(
            (access.role, access.content_key.expose()),
            (Role::Recipient, second.expose())
        );
        assert_eq!(
            open(&file, &device, &[5; 16]).err(),
            Some(AccessFileError::OtherSong)
        );
    }

    #[test]
    fn the_largest_file_is_read_once_and_every_entry_is_checked() {
        let device = device_key();
        let one = wrap(&content_key(), &[0; 16], &device.public_key(), Role::Owner);
        let mut file = one[..HEADER_LEN].to_vec();
        file[12..16].copy_from_slice(&(MAX_ENTRIES as u32).to_le_bytes());
        for i in 0..MAX_ENTRIES {
            let mut entry = one[HEADER_LEN..].to_vec();
            entry[..4].copy_from_slice(&(i as u32).to_be_bytes());
            file.extend_from_slice(&entry);
        }
        assert_eq!(file.len(), 2_129_969);
        assert_eq!(
            open(&file, &device, &[0xff; 16]).err(),
            Some(AccessFileError::OtherSong)
        );
        // A bad entry at the end is found by the structural walk.
        let last = file.len() - ENTRY_LEN + 16;
        file[last] = 0;
        assert_eq!(
            open(&file, &device, &[0xff; 16]).err(),
            Some(AccessFileError::Role)
        );
    }

    #[test]
    fn only_the_intended_device_opens_the_access_file_and_reads_the_song_file() {
        let song = example_song();
        let recovery = RecoveryKey::from_seed(&[5; 32]).expect("a valid seed");
        let key = ContentKey::generate();
        let song_file = v1::write(&song, &key, &recovery.public_key(), v1::Salt::generate())
            .expect("the song is written");

        let device_a = other_key(0x11);
        let code = device_a.public_key().device_code();
        let public = PublicKey::parse_device_code(&code).expect("the code is valid");
        let access_file = wrap(&key, &song.song_id, &public, Role::Recipient);

        let access = open(&access_file, &device_a, &song.song_id).expect("A opens the file");
        assert_eq!(access.role, Role::Recipient);
        assert_eq!(v1::read(&song_file, &access.content_key), Ok(song.clone()));

        // B holds the song file, the access file and A's device code.
        let device_b = other_key(0xff);
        assert_ne!(device_b.public_key().device_code(), code);
        assert_eq!(
            open(&access_file, &device_b, &song.song_id).err(),
            Some(AccessFileError::OtherDevice)
        );
    }

    #[test]
    fn debug_and_error_text_hold_no_key_hex() {
        let key_hex = hex(content_key().expose());
        let scalar = table(DOC, "### Web device key\n\nEach row")[1][1].clone();
        let access = open_documented(&documented()).expect("the file opens");
        let mut texts = vec![format!("{access:?}"), format!("{:?}", access.role)];
        for error in [
            AccessFileError::Magic,
            AccessFileError::Version,
            AccessFileError::Reserved,
            AccessFileError::EntryCount,
            AccessFileError::Size,
            AccessFileError::DeviceKey,
            AccessFileError::Role,
            AccessFileError::Order,
            AccessFileError::Enc,
            AccessFileError::OtherDevice,
            AccessFileError::OtherSong,
            AccessFileError::Open,
        ] {
            texts.push(format!("{error:?} {error}"));
        }
        assert_eq!(
            texts[0],
            "Access { content_key: ContentKey { .. }, role: Owner }"
        );
        for text in texts {
            assert!(!text.contains(&key_hex), "{text}");
            assert!(!text.contains(&scalar), "{text}");
            assert!(!text.contains("0x40"), "{text}");
        }
    }

    #[test]
    fn sharing_from_an_owner_file_opens_for_the_recipient_with_the_recipient_role() {
        let owner = other_key(0x11);
        let recipient = other_key(0x22);
        let key = ContentKey::generate();
        let id = song_id();
        let owner_file = wrap(&key, &id, &owner.public_key(), Role::Owner);

        let shared = share(&owner_file, &owner, &id, &recipient.public_key()).expect("shares");
        let access = open(&shared, &recipient, &id).expect("the recipient opens it");
        assert_eq!(access.role, Role::Recipient);
        assert_eq!(access.content_key.expose(), key.expose());
        assert_eq!(
            open(&shared, &owner, &id).err(),
            Some(AccessFileError::OtherDevice)
        );
    }

    #[test]
    fn sharing_from_a_recipient_file_is_refused() {
        let device = other_key(0x11);
        let id = song_id();
        let file = wrap(&content_key(), &id, &device.public_key(), Role::Recipient);
        assert_eq!(
            share(&file, &device, &id, &other_key(0x22).public_key()),
            Err(ShareError::NotOwner)
        );
    }

    #[test]
    fn sharing_a_song_the_file_has_no_entry_for_is_refused() {
        let device = other_key(0x11);
        let file = wrap(
            &content_key(),
            &song_id(),
            &device.public_key(),
            Role::Owner,
        );
        assert_eq!(
            share(&file, &device, &[7; 16], &other_key(0x22).public_key()),
            Err(ShareError::Access(AccessFileError::OtherSong))
        );
    }

    #[test]
    fn share_errors_hold_no_key_hex() {
        let key_hex = hex(content_key().expose());
        for error in [
            ShareError::NotOwner,
            ShareError::Access(AccessFileError::Open),
        ] {
            let text = format!("{error:?} {error}");
            assert!(!text.contains(&key_hex), "{text}");
        }
    }
}
