//! The FFT that both separators share.

use std::f64::consts::PI;

/// An iterative radix-2 complex FFT of a fixed power-of-two length.
pub(crate) struct Fft {
    n: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
    reversed: Vec<usize>,
}

impl Fft {
    /// Prepares an FFT of length `n`. It panics unless `n` is a power of two.
    pub(crate) fn new(n: usize) -> Fft {
        assert!(
            n.is_power_of_two(),
            "the FFT length {n} is not a power of two"
        );
        let bits = n.trailing_zeros();
        Fft {
            n,
            cos: (0..n / 2)
                .map(|k| (2.0 * PI * k as f64 / n as f64).cos())
                .collect(),
            sin: (0..n / 2)
                .map(|k| (2.0 * PI * k as f64 / n as f64).sin())
                .collect(),
            reversed: (0..n)
                .map(|i| {
                    if bits == 0 {
                        0
                    } else {
                        i.reverse_bits() >> (usize::BITS - bits)
                    }
                })
                .collect(),
        }
    }

    /// Transforms `re` and `im` in place. The inverse conjugates the
    /// twiddles and scales by `1 / n`, as `torch.fft.irfft` does.
    pub(crate) fn transform(&self, re: &mut [f64], im: &mut [f64], inverse: bool) {
        let n = self.n;
        for i in 0..n {
            let j = self.reversed[i];
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { 1.0 } else { -1.0 };
        let mut half = 1;
        while half < n {
            let step = n / (2 * half);
            for start in (0..n).step_by(2 * half) {
                for k in 0..half {
                    let wr = self.cos[k * step];
                    let wi = sign * self.sin[k * step];
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            half *= 2;
        }
        if inverse {
            let scale = 1.0 / n as f64;
            re.iter_mut().for_each(|v| *v *= scale);
            im.iter_mut().for_each(|v| *v *= scale);
        }
    }
}
