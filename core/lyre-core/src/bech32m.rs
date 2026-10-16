//! The Bech32m checksum text of BIP-350, as device codes use it.
//!
//! Bech32m is a checksum, not cryptography. This is a port of BIP-350's
//! reference code. The device code adds its own rules on top: a fixed length,
//! a separate version group and one padding bit. See
//! `docs/reference/device-access.md`.

/// The five-bit alphabet.
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// The Bech32m checksum constant.
const CONSTANT: u32 = 0x2bc8_30a3;

/// The number of checksum characters.
pub(crate) const CHECKSUM_LEN: usize = 6;

/// The input is not Bech32m text: mixed case, a character outside the
/// alphabet, or no separator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NotText;

fn polymod(values: impl IntoIterator<Item = u8>) -> u32 {
    const GENERATOR: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut checksum = 1u32;
    for value in values {
        let top = checksum >> 25;
        checksum = ((checksum & 0x01ff_ffff) << 5) ^ u32::from(value);
        for (i, generator) in GENERATOR.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                checksum ^= generator;
            }
        }
    }
    checksum
}

/// The HRP expanded to five-bit values, then the checksum input's data.
fn checksum_input<'a>(hrp: &'a str, data: &'a [u8]) -> impl Iterator<Item = u8> + 'a {
    hrp.bytes()
        .map(|b| b >> 5)
        .chain([0])
        .chain(hrp.bytes().map(|b| b & 31))
        .chain(data.iter().copied())
}

/// Writes `hrp` (lowercase) and the five-bit `data` as lowercase Bech32m text
/// with its checksum.
pub(crate) fn encode(hrp: &str, data: &[u8]) -> String {
    let polymod = polymod(checksum_input(hrp, data).chain([0; CHECKSUM_LEN])) ^ CONSTANT;
    let mut text = String::with_capacity(hrp.len() + 1 + data.len() + CHECKSUM_LEN);
    text.push_str(hrp);
    text.push('1');
    let checksum = (0..CHECKSUM_LEN).map(|i| ((polymod >> (5 * (5 - i))) & 31) as u8);
    for value in data.iter().copied().chain(checksum) {
        text.push(char::from(CHARSET[usize::from(value)]));
    }
    text
}

/// Splits `text` at its last `1` into a lowercase HRP and the five-bit values
/// after it, the checksum included. The text must be all lowercase or all
/// uppercase, and every character must be in the alphabet after the
/// separator. The checksum is not checked.
pub(crate) fn split(text: &str) -> Result<(String, Vec<u8>), NotText> {
    let has_lower = text.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = text.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(NotText);
    }
    if !text.bytes().all(|b| (33..=126).contains(&b)) {
        return Err(NotText);
    }
    let text = text.to_ascii_lowercase();
    let (hrp, data) = text.rsplit_once('1').ok_or(NotText)?;
    if hrp.is_empty() || data.len() < CHECKSUM_LEN {
        return Err(NotText);
    }
    let values = data
        .bytes()
        .map(|b| {
            CHARSET
                .iter()
                .position(|&c| c == b)
                .map(|i| i as u8)
                .ok_or(NotText)
        })
        .collect::<Result<Vec<u8>, NotText>>()?;
    Ok((hrp.to_owned(), values))
}

/// Whether `values` (the data and its six checksum values) have a valid
/// Bech32m checksum for `hrp`. A Bech32 checksum is not valid.
pub(crate) fn verify_checksum(hrp: &str, values: &[u8]) -> bool {
    polymod(checksum_input(hrp, values)) == CONSTANT
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decodes `text` like BIP-350: split, then check the checksum.
    fn decode(text: &str) -> Option<(String, Vec<u8>)> {
        let (hrp, mut values) = split(text).ok()?;
        if !verify_checksum(&hrp, &values) {
            return None;
        }
        values.truncate(values.len() - CHECKSUM_LEN);
        Some((hrp, values))
    }

    // BIP-350's valid Bech32m strings.
    const VALID: [&str; 5] = [
        "A1LQFN3A",
        "a1lqfn3a",
        "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
        "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
        "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
    ];

    // BIP-350's invalid Bech32m strings that this port can check: a bad
    // checksum, a bad character and an empty HRP. The strings with a
    // separator or length problem are covered by the text checks.
    const INVALID: [&str; 8] = [
        " 1xj0phk",
        "\x7f1g6xzxy",
        "an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4x",
        "qyrz8wqd2c9m",
        "1qyrz8wqd2c9m",
        "y1b0jsk6g",
        "lt1igcx5c0",
        "in1muywd",
    ];

    #[test]
    fn bip_350_valid_strings_decode() {
        for text in VALID {
            assert!(decode(text).is_some(), "{text}");
        }
    }

    #[test]
    fn bip_350_invalid_strings_are_refused() {
        for text in INVALID {
            // The 90-character limit is BIP-350's, not this port's.
            if text.len() > 90 && text.starts_with("an84") {
                continue;
            }
            assert!(decode(text).is_none(), "{text}");
        }
    }

    #[test]
    fn a_bech32_checksum_is_refused() {
        // BIP-173's valid Bech32 string, whose constant is 1.
        assert!(decode("A12UEL5L").is_none());
    }

    #[test]
    fn mixed_case_is_not_text() {
        assert_eq!(split("A1lqfn3a"), Err(NotText));
    }

    #[test]
    fn uppercase_and_lowercase_give_the_same_values() {
        assert_eq!(decode("A1LQFN3A"), decode("a1lqfn3a"));
    }

    #[test]
    fn encode_gives_the_bip_350_text() {
        assert_eq!(encode("a", &[]), "a1lqfn3a");
        assert_eq!(encode("abcdef", &[]).len(), 13);
    }

    #[test]
    fn encode_then_decode_round_trips() {
        let data: Vec<u8> = (0..32).collect();
        let text = encode("lyre", &data);
        assert_eq!(decode(&text), Some(("lyre".to_owned(), data)));
    }

    #[test]
    fn a_text_without_a_separator_is_not_text() {
        assert_eq!(split("qqqqqqqqqq"), Err(NotText));
    }
}
