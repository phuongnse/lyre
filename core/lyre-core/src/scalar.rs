//! The reduction that turns key material into a P-256 private scalar. The web
//! device key and the recovery key pair share it. Each has its own HKDF label.

use hkdf::Hkdf;
use p256::elliptic_curve::ops::Reduce;
use p256::{FieldBytes, NonZeroScalar, Scalar};
use sha2::Sha256;
use zeroize::Zeroizing;

/// The size of the HKDF output, in bytes.
const OKM_LEN: usize = 48;

/// Derives a private scalar with HKDF-SHA256, an empty salt and a 48-byte
/// output, then reduces it. None when the scalar is zero.
pub(crate) fn derive_scalar(ikm: &[u8], info: &[u8]) -> Option<NonZeroScalar> {
    let mut okm = Zeroizing::new([0u8; OKM_LEN]);
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, okm.as_mut_slice())
        .expect("48 bytes are within the HKDF limit");
    scalar_from_wide(&okm)
}

/// Reads 48 big-endian bytes as one integer, reduces it modulo the group
/// order `n` and rejects zero.
pub(crate) fn scalar_from_wide(okm: &[u8; OKM_LEN]) -> Option<NonZeroScalar> {
    let (hi, lo) = okm.split_at(OKM_LEN - 32);
    let mut hi_bytes = FieldBytes::default();
    hi_bytes[32 - hi.len()..].copy_from_slice(hi);
    let hi = <Scalar as Reduce<p256::U256>>::reduce_bytes(&hi_bytes);
    let lo = <Scalar as Reduce<p256::U256>>::reduce_bytes(FieldBytes::from_slice(lo));
    let two_64 = Scalar::from(1u64 << 63) * Scalar::from(2u64);
    let two_128 = two_64 * two_64;
    let two_256 = two_128 * two_128;
    let scalar = hi * two_256 + lo;
    Option::from(NonZeroScalar::new(scalar))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
            .collect()
    }

    #[test]
    fn a_reduced_scalar_of_zero_is_rejected() {
        // The group order n of P-256, as 48 big-endian bytes.
        let n = unhex(
            "00000000000000000000000000000000ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
        );
        let n: [u8; 48] = n.try_into().expect("48 bytes");
        assert!(scalar_from_wide(&n).is_none());
        assert!(scalar_from_wide(&[0; 48]).is_none());
        let mut n_plus_one = n;
        n_plus_one[47] += 1;
        let one = scalar_from_wide(&n_plus_one).expect("n + 1 reduces to 1");
        assert_eq!(*one, Scalar::ONE);
    }

    #[test]
    fn a_wide_value_reduces_modulo_n() {
        // 2^256 mod n is 2^256 − n, so the 48 bytes 01 00…00 reduce to it.
        let mut wide = [0u8; 48];
        wide[15] = 1;
        let reduced = scalar_from_wide(&wide).expect("not zero");
        assert_eq!(
            hex(&reduced.to_bytes()),
            "00000000ffffffff00000000000000004319055258e8617b0c46353d039cdaaf"
        );
    }
}
