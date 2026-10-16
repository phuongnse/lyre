//! The web device key, the device code and the fingerprint.
//!
//! The bytes and text are in `docs/reference/device-access.md`. The private
//! key stays inside [`DeviceKey`]: no function returns its bytes, and its
//! `Debug` text shows nothing of it.

use std::fmt;

use crate::bech32m;
use crate::scalar::derive_scalar;
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use qrcodegen::{QrCodeEcc, QrSegment, Version};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// The fixed Lyre PRF salt, as text. The client passes its UTF-8 bytes as the
/// WebAuthn PRF `eval.first` input.
pub const PRF_SALT: &str = "lyre/v1/device-key/prf";

/// The HKDF `info` of the web device key.
const DEVICE_KEY_INFO: &[u8] = b"lyre/v1/device-key";

/// The size of a PRF output, in bytes.
const PRF_LEN: usize = 32;

/// The size of a compressed P-256 public key, in bytes.
const COMPRESSED_LEN: usize = 33;

/// The human-readable part of a device code.
const HRP: &str = "lyre";

/// The device code version.
const VERSION: u8 = 1;

/// The number of five-bit groups that hold the public key.
const KEY_GROUPS: usize = 53;

/// The length of a device code, in characters: the HRP, the separator, the
/// version group, the key groups and the checksum.
const CODE_LEN: usize = HRP.len() + 1 + 1 + KEY_GROUPS + bech32m::CHECKSUM_LEN;

/// Why a web device key could not be derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyError {
    /// The PRF output is not 32 bytes.
    PrfLength,
    /// The reduced scalar is zero.
    ZeroScalar,
}

impl fmt::Display for DeviceKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeviceKeyError::PrfLength => write!(f, "the PRF output is not {PRF_LEN} bytes"),
            DeviceKeyError::ZeroScalar => write!(f, "the derived private scalar is zero"),
        }
    }
}

impl std::error::Error for DeviceKeyError {}

/// Why a device code was refused. Each reason is one row of the
/// rejections table in the reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceCodeError {
    /// Mixed case, internal whitespace, a character outside Bech32m or the
    /// wrong human-readable part.
    Text,
    /// The trimmed text is not 65 characters.
    Length,
    /// The checksum is not a valid Bech32m checksum.
    Checksum,
    /// The version is not 1.
    Version,
    /// The padding bit is set.
    Padding,
    /// The key is not a compressed point on the curve.
    Key,
}

impl fmt::Display for DeviceCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            DeviceCodeError::Text => "the device code is not valid text",
            DeviceCodeError::Length => "the device code has the wrong length",
            DeviceCodeError::Checksum => "the device code has a bad checksum",
            DeviceCodeError::Version => "the device code has an unknown version",
            DeviceCodeError::Padding => "the device code has a bad padding bit",
            DeviceCodeError::Key => "the device code holds no valid public key",
        };
        write!(f, "{reason}")
    }
}

impl std::error::Error for DeviceCodeError {}

/// This device's key pair. The private key stays inside and cannot be read.
pub struct DeviceKey {
    secret: SecretKey,
}

impl fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceKey {{ .. }}")
    }
}

impl DeviceKey {
    /// Derives the key from a passkey's 32-byte PRF output. The same output
    /// always gives the same key.
    pub fn from_prf_output(prf_output: &[u8]) -> Result<DeviceKey, DeviceKeyError> {
        if prf_output.len() != PRF_LEN {
            return Err(DeviceKeyError::PrfLength);
        }
        let scalar =
            derive_scalar(prf_output, DEVICE_KEY_INFO).ok_or(DeviceKeyError::ZeroScalar)?;
        Ok(DeviceKey {
            secret: SecretKey::from(scalar),
        })
    }

    /// The public key.
    pub fn public_key(&self) -> PublicKey {
        let point = self.secret.public_key().to_encoded_point(true);
        let bytes = <[u8; COMPRESSED_LEN]>::try_from(point.as_bytes())
            .expect("a compressed point is 33 bytes");
        PublicKey(bytes)
    }

    /// The private key as bytes, for the crate's own HPKE code.
    pub(crate) fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.secret.to_bytes().into())
    }
}

/// A QR code, as its dark modules. It has no quiet zone: the client adds the
/// blank border.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrCode {
    /// The side of the square symbol, in modules.
    pub size: usize,
    /// The modules row by row, from the top left. True is dark.
    pub dark: Vec<bool>,
}

/// A device's public key: 33 bytes, SEC1 compressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey([u8; COMPRESSED_LEN]);

impl PublicKey {
    /// The 33-byte SEC1 compressed encoding.
    pub fn to_compressed(&self) -> [u8; COMPRESSED_LEN] {
        self.0
    }

    /// The 65-byte SEC1 uncompressed encoding, for the crate's own HPKE code.
    pub(crate) fn to_uncompressed(&self) -> [u8; 65] {
        let key = p256::PublicKey::from_sec1_bytes(&self.0)
            .expect("a device public key is a valid point");
        <[u8; 65]>::try_from(key.to_encoded_point(false).as_bytes())
            .expect("an uncompressed point is 65 bytes")
    }

    /// The device code: 65 lowercase characters starting with `lyre1p`.
    pub fn device_code(&self) -> String {
        let mut data = Vec::with_capacity(1 + KEY_GROUPS);
        data.push(VERSION);
        data.extend(to_five_bit(&self.0));
        bech32m::encode(HRP, &data)
    }

    /// The fingerprint: 20 digits in five groups of four.
    pub fn fingerprint(&self) -> String {
        let hash = Sha256::digest(self.0);
        let groups: Vec<String> = (0..5)
            .map(|i| {
                let value = hash[5 * i..5 * i + 5]
                    .iter()
                    .fold(0u64, |n, &b| (n << 8) | u64::from(b));
                format!("{:04}", value % 10_000)
            })
            .collect();
        groups.join(" ")
    }

    /// The device code as a QR code: the uppercase code in one alphanumeric
    /// segment at error correction level M. Its 65 characters always make
    /// version 4, a 33 × 33 symbol.
    pub fn qr_code(&self) -> QrCode {
        let segments = [QrSegment::make_alphanumeric(
            &self.device_code().to_uppercase(),
        )];
        // Boosting the level is off, so the level stays M.
        let code = qrcodegen::QrCode::encode_segments_advanced(
            &segments,
            QrCodeEcc::Medium,
            Version::MIN,
            Version::MAX,
            None,
            false,
        )
        .expect("a device code fits in a QR code");
        let size = code.size() as usize;
        let dark = (0..size * size)
            .map(|i| code.get_module((i % size) as i32, (i / size) as i32))
            .collect();
        QrCode { size, dark }
    }

    /// Reads a device code, typed or scanned. Whitespace around it is
    /// ignored. The text may be all lowercase or all uppercase.
    pub fn parse_device_code(text: &str) -> Result<PublicKey, DeviceCodeError> {
        let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
        let (hrp, values) = bech32m::split(text).map_err(|_| DeviceCodeError::Text)?;
        if text.len() != CODE_LEN {
            return Err(DeviceCodeError::Length);
        }
        if hrp != HRP {
            return Err(DeviceCodeError::Text);
        }
        if !bech32m::verify_checksum(&hrp, &values) {
            return Err(DeviceCodeError::Checksum);
        }
        let data = &values[..values.len() - bech32m::CHECKSUM_LEN];
        let (version, groups) = data.split_first().expect("the length is fixed");
        if *version != VERSION {
            return Err(DeviceCodeError::Version);
        }
        let bytes = from_five_bit(groups).ok_or(DeviceCodeError::Padding)?;
        // Only a compressed key, `02` or `03`, is accepted. `04` and `00`
        // are refused here, whatever the curve library would do.
        if bytes[0] != 0x02 && bytes[0] != 0x03 {
            return Err(DeviceCodeError::Key);
        }
        p256::PublicKey::from_sec1_bytes(&bytes).map_err(|_| DeviceCodeError::Key)?;
        Ok(PublicKey(bytes))
    }
}

/// Converts bytes to five-bit groups, most significant bit first, with zero
/// padding bits in the last group.
fn to_five_bit(bytes: &[u8]) -> Vec<u8> {
    let mut groups = Vec::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut accumulator = 0u32;
    let mut bits = 0;
    for &byte in bytes {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            groups.push(((accumulator >> bits) & 31) as u8);
        }
        accumulator &= (1 << bits) - 1;
    }
    if bits > 0 {
        groups.push(((accumulator << (5 - bits)) & 31) as u8);
    }
    groups
}

/// Converts the 53 key groups back to 33 bytes. None when the padding bit is
/// set.
fn from_five_bit(groups: &[u8]) -> Option<[u8; COMPRESSED_LEN]> {
    let mut bytes = [0u8; COMPRESSED_LEN];
    let mut accumulator = 0u32;
    let mut bits = 0;
    let mut index = 0;
    for &group in groups {
        accumulator = (accumulator << 5) | u32::from(group);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes[index] = ((accumulator >> bits) & 0xff) as u8;
            index += 1;
            accumulator &= (1 << bits) - 1;
        }
    }
    (index == COMPRESSED_LEN && accumulator == 0).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = include_str!("../../../docs/reference/device-access.md");

    /// The rows of the first table after `heading`, or after the `after` text
    /// that follows it, as cells with their backticks removed.
    fn table(heading: &str, after: Option<&str>) -> Vec<Vec<String>> {
        let (_, section) = DOC.split_once(heading).expect("the doc has the heading");
        let section = match after {
            Some(marker) => section.split_once(marker).expect("the marker").1,
            None => section,
        };
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

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn key_rows() -> Vec<Vec<String>> {
        table("### Web device key", None)
    }

    fn code_rows() -> Vec<Vec<String>> {
        table("### Device code and fingerprint", None)
    }

    fn invalid_rows() -> Vec<Vec<String>> {
        table(
            "### Device code and fingerprint",
            Some("Each invalid row is rejected"),
        )
    }

    #[test]
    fn the_doc_has_three_key_rows_three_code_rows_and_ten_invalid_rows() {
        assert_eq!(key_rows().len(), 3);
        assert_eq!(code_rows().len(), 3);
        assert_eq!(invalid_rows().len(), 10);
    }

    #[test]
    fn a_prf_output_gives_the_documented_key() {
        for row in key_rows() {
            let key = DeviceKey::from_prf_output(&unhex(&row[0])).expect("a valid output");
            assert_eq!(hex(&key.secret.to_bytes()), row[1], "{}", row[0]);
            assert_eq!(hex(&key.public_key().to_compressed()), row[2], "{}", row[0]);
        }
    }

    #[test]
    fn the_same_prf_output_gives_the_same_key() {
        let a = DeviceKey::from_prf_output(&[7; 32]).expect("valid");
        let b = DeviceKey::from_prf_output(&[7; 32]).expect("valid");
        let c = DeviceKey::from_prf_output(&[8; 32]).expect("valid");
        assert_eq!(a.public_key(), b.public_key());
        assert_ne!(a.public_key(), c.public_key());
    }

    #[test]
    fn a_public_key_gives_the_documented_code_and_fingerprint() {
        for row in code_rows() {
            let key = PublicKey(unhex(&row[0]).try_into().expect("33 bytes"));
            assert_eq!(key.device_code(), row[1]);
            assert_eq!(key.fingerprint(), row[2]);
            assert_eq!(key.device_code().len(), 65);
        }
    }

    #[test]
    fn the_codes_belong_to_the_documented_keys() {
        let keys: Vec<String> = key_rows().into_iter().map(|row| row[2].clone()).collect();
        let codes: Vec<String> = code_rows().into_iter().map(|row| row[0].clone()).collect();
        assert_eq!(keys, codes);
    }

    /// Draws the modules black on white with a quiet zone of four modules,
    /// four pixels to a module, and reads the first QR code in the picture.
    fn read_qr(qr: &QrCode) -> (rqrr::MetaData, String) {
        const QUIET: usize = 4;
        const SCALE: usize = 4;
        let side = (qr.size + 2 * QUIET) * SCALE;
        let mut image = rqrr::PreparedImage::prepare_from_greyscale(side, side, |x, y| {
            let (column, row) = (x / SCALE, y / SCALE);
            let inside = (QUIET..QUIET + qr.size).contains(&column)
                && (QUIET..QUIET + qr.size).contains(&row);
            if inside && qr.dark[(row - QUIET) * qr.size + column - QUIET] {
                0
            } else {
                255
            }
        });
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1);
        grids[0].decode().expect("the QR code decodes")
    }

    #[test]
    fn a_qr_code_decodes_to_the_uppercase_code_in_33_by_33_at_level_m() {
        for row in code_rows() {
            let key = PublicKey(unhex(&row[0]).try_into().expect("33 bytes"));
            let qr = key.qr_code();
            assert_eq!(qr.size, 33, "{}", row[1]);
            assert_eq!(qr.dark.len(), 33 * 33);
            let (meta, text) = read_qr(&qr);
            assert_eq!(text, row[1].to_uppercase());
            assert_eq!(meta.version.0, 4);
            // rqrr numbers the levels as the format bits do: M is 0.
            assert_eq!(meta.ecc_level, 0);
        }
    }

    #[test]
    fn a_qr_code_is_the_same_every_time() {
        let key = PublicKey(unhex(&code_rows()[0][0]).try_into().expect("33 bytes"));
        assert_eq!(key.qr_code(), key.qr_code());
    }

    #[test]
    fn a_code_parses_in_lowercase_uppercase_and_with_whitespace() {
        for row in code_rows() {
            let expected = PublicKey(unhex(&row[0]).try_into().expect("33 bytes"));
            let variants = [
                row[1].clone(),
                row[1].to_uppercase(),
                format!(" \n{}\t ", row[1]),
                format!(" \r\n{} ", row[1].to_uppercase()),
            ];
            for text in variants {
                assert_eq!(PublicKey::parse_device_code(&text), Ok(expected.clone()));
            }
        }
    }

    #[test]
    fn an_invalid_code_is_rejected_with_its_reason() {
        for row in invalid_rows() {
            let reason = match row[2].as_str() {
                "Text" => DeviceCodeError::Text,
                "Length" => DeviceCodeError::Length,
                "Checksum" => DeviceCodeError::Checksum,
                "Version" => DeviceCodeError::Version,
                "Padding" => DeviceCodeError::Padding,
                "Key" => DeviceCodeError::Key,
                other => panic!("unknown reason {other}"),
            };
            assert_eq!(
                PublicKey::parse_device_code(&row[1]),
                Err(reason),
                "{}",
                row[0]
            );
        }
    }

    #[test]
    fn whitespace_inside_a_code_is_rejected() {
        let code = code_rows()[0][1].clone();
        let text = format!("{} {}", &code[..30], &code[30..]);
        assert_eq!(
            PublicKey::parse_device_code(&text),
            Err(DeviceCodeError::Text)
        );
    }

    #[test]
    fn text_that_is_not_a_code_is_rejected() {
        for text in ["", "lyre", "lyre1", "é", "\u{3000}"] {
            assert!(PublicKey::parse_device_code(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn a_prf_output_that_is_not_32_bytes_is_rejected() {
        for len in [0, 31, 33, 64] {
            assert_eq!(
                DeviceKey::from_prf_output(&vec![1; len]).err(),
                Some(DeviceKeyError::PrfLength)
            );
        }
    }

    #[test]
    fn debug_text_holds_no_private_scalar() {
        for row in key_rows() {
            let key = DeviceKey::from_prf_output(&unhex(&row[0])).expect("valid");
            let text = format!("{key:?}");
            assert_eq!(text, "DeviceKey { .. }");
            assert!(!text.contains(&row[1]));
            let public = format!("{:?}", key.public_key());
            assert!(!public.contains(&row[1]));
        }
    }

    #[test]
    fn error_text_holds_no_private_scalar() {
        let scalars: Vec<String> = key_rows().into_iter().map(|row| row[1].clone()).collect();
        let key_errors = [DeviceKeyError::PrfLength, DeviceKeyError::ZeroScalar];
        let code_errors = [
            DeviceCodeError::Text,
            DeviceCodeError::Length,
            DeviceCodeError::Checksum,
            DeviceCodeError::Version,
            DeviceCodeError::Padding,
            DeviceCodeError::Key,
        ];
        let mut texts = Vec::new();
        for error in key_errors {
            texts.push(format!("{error:?} {error}"));
        }
        for error in code_errors {
            texts.push(format!("{error:?} {error}"));
        }
        for text in texts {
            for scalar in &scalars {
                assert!(!text.contains(scalar));
            }
        }
    }
}
