//! Separation: the steps around the htdemucs model that its file leaves out.
//!
//! Before the model, [`prepare`] turns one stereo segment into the model's
//! normalised `x` and `xt` inputs. After the model, [`finish`] turns the
//! outputs into four stereo stems. The steps are those of Demucs 4.0.1
//! `HTDemucs._spec`, `_ispec`, `_magnitude`, `_mask` and the normalisation in
//! `forward`, as `tools/model-tool/compare_htdemucs.py` `separate_with_onnx`
//! repeats them. See `docs/reference/models.md#htdemucs`.
//!
//! Arrays are flat `f32` vectors in the models' row-major tensor layout,
//! without the batch dimension. The arithmetic inside runs in `f64`.
//!
//! - `xt` and each stereo waveform: `[c * SEGMENT_SAMPLES + n]`.
//! - `x`: `[(k * BINS + bin) * FRAMES + frame]`, where channel `k = 2 * c`
//!   holds the real part and `k = 2 * c + 1` the imaginary part.
//! - `x_out`: stem `s` takes channels `4s..4s + 4`, in the layout of `x`.
//! - `xt_out` and the stems: stem `s` takes channels `2s..2s + 2`.

use std::f64::consts::PI;
use std::fmt;

/// The samples per channel in one segment.
pub const SEGMENT_SAMPLES: usize = 343_980;
/// The channels of a segment: stereo.
pub const CHANNELS: usize = 2;
/// The length of each FFT frame.
pub const N_FFT: usize = 4096;
/// The samples between two FFT frames.
pub const HOP: usize = 1024;
/// The frequency bins in the model's input. The Nyquist bin is dropped.
pub const BINS: usize = 2048;
/// The time frames in the model's input.
pub const FRAMES: usize = 336;
/// The stems, in the order the model gives them.
pub const STEMS: [&str; 4] = ["drums", "bass", "other", "vocals"];
/// Added to the standard deviation before dividing, as Demucs does.
pub const EPSILON: f32 = 1e-5;

/// The values in `x`: four channels of `BINS` by `FRAMES`.
pub const X_LEN: usize = 4 * BINS * FRAMES;
/// The values in `xt` and in a segment.
pub const XT_LEN: usize = CHANNELS * SEGMENT_SAMPLES;
/// The values in `x_out`: one `x` per stem.
pub const X_OUT_LEN: usize = STEMS.len() * X_LEN;
/// The values in `xt_out`, and in the stems: one segment per stem.
pub const XT_OUT_LEN: usize = STEMS.len() * XT_LEN;

/// The rows the padded spectrogram has: `ceil(SEGMENT_SAMPLES / HOP)`.
const LE: usize = SEGMENT_SAMPLES.div_ceil(HOP);
/// Demucs's padding of the segment before the STFT.
const PAD: usize = HOP / 2 * 3;
/// The length of the padded segment.
const PADDED: usize = LE * HOP + 2 * PAD;
/// The frames the STFT of the padded segment has, with its centring.
const STFT_FRAMES: usize = PADDED / HOP + 1;
/// The first of the `FRAMES` frames Demucs keeps.
const FIRST_FRAME: usize = 2;
/// The scale of `normalized=True`: `sqrt(N_FFT)`.
const NORM_SCALE: f64 = 64.0;
/// The smallest window envelope that torch's inverse STFT accepts.
const MIN_ENVELOPE: f64 = 1e-11;

/// The mean and standard deviation an input was normalised with.
#[derive(Debug, Clone, PartialEq)]
pub struct Normalisation {
    pub mean: f32,
    pub std: f32,
}

/// What the model takes, and what [`finish`] needs back.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInput {
    /// The normalised spectrogram, `X_LEN` values.
    pub x: Vec<f32>,
    /// The normalised waveform, `XT_LEN` values.
    pub xt: Vec<f32>,
    pub x_norm: Normalisation,
    pub xt_norm: Normalisation,
}

/// Why a step was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum SeparationError {
    /// A buffer has `actual` values, but `expected` are needed.
    WrongLength {
        what: &'static str,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for SeparationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SeparationError::WrongLength {
                what,
                expected,
                actual,
            } => write!(
                f,
                "the {what} has {actual} values, but {expected} are expected"
            ),
        }
    }
}

impl std::error::Error for SeparationError {}

fn check_length(what: &'static str, expected: usize, actual: usize) -> Result<(), SeparationError> {
    if expected == actual {
        Ok(())
    } else {
        Err(SeparationError::WrongLength {
            what,
            expected,
            actual,
        })
    }
}

/// Makes the model's inputs from one stereo segment of `XT_LEN` values.
pub fn prepare(segment: &[f32]) -> Result<ModelInput, SeparationError> {
    check_length("segment", XT_LEN, segment.len())?;
    let mut x = spectrogram(segment)?;
    let mut xt = segment.to_vec();
    let x_norm = normalise(&mut x);
    let xt_norm = normalise(&mut xt);
    Ok(ModelInput {
        x,
        xt,
        x_norm,
        xt_norm,
    })
}

/// Makes the four stereo stems from the model's outputs. The result has
/// `XT_OUT_LEN` values, in the order of [`STEMS`].
pub fn finish(
    x_norm: &Normalisation,
    xt_norm: &Normalisation,
    x_out: &[f32],
    xt_out: &[f32],
) -> Result<Vec<f32>, SeparationError> {
    check_length("x_out", X_OUT_LEN, x_out.len())?;
    check_length("xt_out", XT_OUT_LEN, xt_out.len())?;
    let mut stems = Vec::with_capacity(XT_OUT_LEN);
    for stem in 0..STEMS.len() {
        let mut spec = x_out[stem * X_LEN..(stem + 1) * X_LEN].to_vec();
        let wave = &xt_out[stem * XT_LEN..(stem + 1) * XT_LEN];
        denormalise(&mut spec, x_norm);
        let from_spectrum = waveform(&spec)?;
        stems.extend(wave.iter().zip(&from_spectrum).map(|(&w, &s)| {
            // Undo the waveform's normalisation, then add the two branches.
            denormalised(w, xt_norm) + s
        }));
    }
    Ok(stems)
}

/// Normalises `values` in place as `(v - mean) / (std + EPSILON)` and returns
/// the mean and standard deviation. The deviation divides by `n - 1`, as
/// PyTorch's `std` does.
pub fn normalise(values: &mut [f32]) -> Normalisation {
    let count = values.len() as f64;
    let mean = values.iter().map(|&v| f64::from(v)).sum::<f64>() / count;
    let std = if values.len() < 2 {
        0.0
    } else {
        let squares: f64 = values.iter().map(|&v| (f64::from(v) - mean).powi(2)).sum();
        (squares / (count - 1.0)).sqrt()
    };
    let norm = Normalisation {
        mean: mean as f32,
        std: std as f32,
    };
    let divisor = f64::from(norm.std) + f64::from(EPSILON);
    for v in values.iter_mut() {
        *v = ((f64::from(*v) - f64::from(norm.mean)) / divisor) as f32;
    }
    norm
}

/// Undoes [`normalise`] in place as `v * std + mean`. Like Demucs, it leaves
/// out `EPSILON`, so the round trip is off by about `(v - mean) * EPSILON /
/// std`.
pub fn denormalise(values: &mut [f32], norm: &Normalisation) {
    for v in values.iter_mut() {
        *v = denormalised(*v, norm);
    }
}

fn denormalised(value: f32, norm: &Normalisation) -> f32 {
    (f64::from(value) * f64::from(norm.std) + f64::from(norm.mean)) as f32
}

/// The spectrogram of a segment, not normalised: (4, `BINS`, `FRAMES`).
pub fn spectrogram(segment: &[f32]) -> Result<Vec<f32>, SeparationError> {
    check_length("segment", XT_LEN, segment.len())?;
    let fft = Fft::new();
    let window = hann();
    let mut out = vec![0.0f32; X_LEN];
    let mut re = vec![0.0f64; N_FFT];
    let mut im = vec![0.0f64; N_FFT];
    for c in 0..CHANNELS {
        let channel = &segment[c * SEGMENT_SAMPLES..(c + 1) * SEGMENT_SAMPLES];
        let channel: Vec<f64> = channel.iter().map(|&v| f64::from(v)).collect();
        let padded = reflect_pad(&channel, PAD, PADDED - PAD - SEGMENT_SAMPLES);
        let padded = reflect_pad(&padded, N_FFT / 2, N_FFT / 2);
        for frame in 0..FRAMES {
            let start = (frame + FIRST_FRAME) * HOP;
            for (n, ((r, i), w)) in re.iter_mut().zip(&mut im).zip(&window).enumerate() {
                *r = padded[start + n] * w;
                *i = 0.0;
            }
            fft.transform(&mut re, &mut im, false);
            for (bin, (&r, &i)) in re.iter().zip(&im).take(BINS).enumerate() {
                out[((2 * c) * BINS + bin) * FRAMES + frame] = (r / NORM_SCALE) as f32;
                out[((2 * c + 1) * BINS + bin) * FRAMES + frame] = (i / NORM_SCALE) as f32;
            }
        }
    }
    Ok(out)
}

/// The stereo waveform of a spectrogram of `X_LEN` values, by the inverse
/// STFT. It has `XT_LEN` values. The first and last samples of the segment
/// are rebuilt only roughly, because Demucs keeps too few frames to cover
/// them.
pub fn waveform(spec: &[f32]) -> Result<Vec<f32>, SeparationError> {
    check_length("spectrogram", X_LEN, spec.len())?;
    let fft = Fft::new();
    let window = hann();
    let length = (STFT_FRAMES - 1) * HOP + N_FFT;
    // The window's squares, summed over all frames, including the zero ones.
    let mut envelope = vec![0.0f64; length];
    for t in 0..STFT_FRAMES {
        for (e, w) in envelope[t * HOP..].iter_mut().zip(&window) {
            *e += w * w;
        }
    }
    let mut out = vec![0.0f32; XT_LEN];
    let mut re = vec![0.0f64; N_FFT];
    let mut im = vec![0.0f64; N_FFT];
    let mut signal = vec![0.0f64; length];
    for c in 0..CHANNELS {
        let channel = &mut out[c * SEGMENT_SAMPLES..(c + 1) * SEGMENT_SAMPLES];
        signal.fill(0.0);
        for frame in 0..FRAMES {
            re.fill(0.0);
            im.fill(0.0);
            for bin in 0..BINS {
                let r = f64::from(spec[((2 * c) * BINS + bin) * FRAMES + frame]) * NORM_SCALE;
                let i = f64::from(spec[((2 * c + 1) * BINS + bin) * FRAMES + frame]) * NORM_SCALE;
                re[bin] = r;
                im[bin] = i;
                if bin > 0 {
                    re[N_FFT - bin] = r;
                    im[N_FFT - bin] = -i;
                }
            }
            fft.transform(&mut re, &mut im, true);
            let start = (frame + FIRST_FRAME) * HOP;
            for ((s, &r), w) in signal[start..].iter_mut().zip(&re).zip(&window) {
                *s += r * w;
            }
        }
        // Drop the centring, then the padding of `spectrogram`.
        let skip = N_FFT / 2 + PAD;
        for (n, v) in channel.iter_mut().enumerate() {
            let at = skip + n;
            let divisor = envelope[at];
            *v = if divisor > MIN_ENVELOPE {
                (signal[at] / divisor) as f32
            } else {
                signal[at] as f32
            };
        }
    }
    Ok(out)
}

/// A periodic Hann window of `N_FFT` values, as `torch.hann_window`.
fn hann() -> Vec<f64> {
    (0..N_FFT)
        .map(|n| 0.5 - 0.5 * (2.0 * PI * n as f64 / N_FFT as f64).cos())
        .collect()
}

/// Pads a signal by reflecting it, without repeating the edge sample, as
/// torch's reflect mode does.
fn reflect_pad(signal: &[f64], left: usize, right: usize) -> Vec<f64> {
    let len = signal.len();
    let mut out = Vec::with_capacity(left + len + right);
    out.extend((0..left).map(|j| signal[left - j]));
    out.extend_from_slice(signal);
    out.extend((0..right).map(|i| signal[len - 2 - i]));
    out
}

/// An iterative radix-2 complex FFT of length `N_FFT`.
struct Fft {
    cos: Vec<f64>,
    sin: Vec<f64>,
    reversed: Vec<usize>,
}

impl Fft {
    fn new() -> Fft {
        let bits = N_FFT.trailing_zeros();
        Fft {
            cos: (0..N_FFT / 2)
                .map(|k| (2.0 * PI * k as f64 / N_FFT as f64).cos())
                .collect(),
            sin: (0..N_FFT / 2)
                .map(|k| (2.0 * PI * k as f64 / N_FFT as f64).sin())
                .collect(),
            reversed: (0..N_FFT)
                .map(|i| i.reverse_bits() >> (usize::BITS - bits))
                .collect(),
        }
    }

    /// Transforms `re` and `im` in place. The inverse conjugates the
    /// twiddles and scales by `1 / N_FFT`, as `torch.fft.irfft` does.
    fn transform(&self, re: &mut [f64], im: &mut [f64], inverse: bool) {
        for i in 0..N_FFT {
            let j = self.reversed[i];
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { 1.0 } else { -1.0 };
        let mut half = 1;
        while half < N_FFT {
            let step = N_FFT / (2 * half);
            for start in (0..N_FFT).step_by(2 * half) {
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
            let scale = 1.0 / N_FFT as f64;
            re.iter_mut().for_each(|v| *v *= scale);
            im.iter_mut().for_each(|v| *v *= scale);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo() -> Vec<f32> {
        let mut segment = Vec::with_capacity(XT_LEN);
        let t = |n: usize| n as f64 / 44_100.0;
        segment.extend((0..SEGMENT_SAMPLES).map(|n| {
            (0.5 * (2.0 * PI * 440.0 * t(n)).sin() + 0.1 * (2.0 * PI * 3000.0 * t(n)).sin()) as f32
        }));
        segment.extend((0..SEGMENT_SAMPLES).map(|n| {
            (0.3 * (2.0 * PI * 220.0 * t(n)).sin()
                + 0.2 * (2.0 * PI * 5000.0 * t(n)).sin()
                + 0.1 * n as f64 / SEGMENT_SAMPLES as f64) as f32
        }));
        segment
    }

    #[test]
    fn inverse_stft_gives_back_the_signal_away_from_the_edges() {
        let segment = stereo();
        let back = waveform(&spectrogram(&segment).unwrap()).unwrap();
        assert_eq!(back.len(), XT_LEN);
        for c in 0..CHANNELS {
            for n in 1536..=342_528 {
                let at = c * SEGMENT_SAMPLES + n;
                assert!(
                    (back[at] - segment[at]).abs() <= 1e-4,
                    "channel {c} sample {n}: {} against {}",
                    back[at],
                    segment[at]
                );
            }
        }
    }

    #[test]
    fn a_tone_peaks_at_its_bin_and_the_shape_is_4_by_2048_by_336() {
        let mut segment = vec![0.0f32; XT_LEN];
        for (n, v) in segment[..SEGMENT_SAMPLES].iter_mut().enumerate() {
            *v = (2.0 * PI * 100.0 * n as f64 / 4096.0).sin() as f32;
        }
        let spec = spectrogram(&segment).unwrap();
        assert_eq!(spec.len(), 4 * 2048 * 336);
        let frame = 168;
        let power = |bin: usize| {
            let re = spec[bin * FRAMES + frame];
            let im = spec[(BINS + bin) * FRAMES + frame];
            re * re + im * im
        };
        let peak = (0..BINS)
            .max_by(|&a, &b| power(a).total_cmp(&power(b)))
            .unwrap();
        assert_eq!(peak, 100);
    }

    #[test]
    fn normalising_then_undoing_gives_back_the_input() {
        let original: Vec<f32> = (0..10_000)
            .map(|n| 1.0 + 4.0 * ((n * 7919) % 10_000) as f32 / 10_000.0)
            .collect();
        let mut values = original.clone();
        let norm = normalise(&mut values);
        assert!(norm.std > 0.5 && norm.std < 2.0);
        denormalise(&mut values, &norm);
        for (back, v) in values.iter().zip(&original) {
            assert!((back - v).abs() <= 1e-4 * v.abs().max(1.0));
        }
    }

    #[test]
    fn normalising_a_constant_gives_no_nan() {
        let mut values = vec![0.25f32; 100];
        let norm = normalise(&mut values);
        assert_eq!(norm.std, 0.0);
        assert!(values.iter().all(|v| v.is_finite()));
        let mut single = vec![3.0f32];
        assert_eq!(normalise(&mut single).std, 0.0);
    }

    #[test]
    fn the_standard_deviation_divides_by_n_minus_1() {
        let mut values = vec![1.0f32, 3.0];
        let norm = normalise(&mut values);
        assert_eq!(norm.mean, 2.0);
        assert!((norm.std - 2.0f32.sqrt()).abs() < 1e-6);
    }

    fn wrong(what: &'static str, expected: usize, actual: usize) -> SeparationError {
        SeparationError::WrongLength {
            what,
            expected,
            actual,
        }
    }

    #[test]
    fn wrong_lengths_are_refused() {
        for len in [XT_LEN - 1, XT_LEN + 1] {
            assert_eq!(prepare(&vec![0.0; len]), Err(wrong("segment", XT_LEN, len)));
        }
        let norm = Normalisation {
            mean: 0.0,
            std: 1.0,
        };
        for len in [X_OUT_LEN - 1, X_OUT_LEN + 1] {
            assert_eq!(
                finish(&norm, &norm, &vec![0.0; len], &vec![0.0; XT_OUT_LEN]),
                Err(wrong("x_out", X_OUT_LEN, len))
            );
        }
        for len in [XT_OUT_LEN - 1, XT_OUT_LEN + 1] {
            assert_eq!(
                finish(&norm, &norm, &vec![0.0; X_OUT_LEN], &vec![0.0; len]),
                Err(wrong("xt_out", XT_OUT_LEN, len))
            );
        }
        assert_eq!(
            wrong("segment", 687_960, 343_979).to_string(),
            "the segment has 343979 values, but 687960 are expected"
        );
    }

    #[test]
    fn stems_come_back_in_the_order_drums_bass_other_vocals() {
        let norm = Normalisation {
            mean: 0.0,
            std: 1.0,
        };
        let xt_out: Vec<f32> = (0..STEMS.len())
            .flat_map(|s| std::iter::repeat_n(s as f32 + 1.0, XT_LEN))
            .collect();
        let stems = finish(&norm, &norm, &vec![0.0; X_OUT_LEN], &xt_out).unwrap();
        assert_eq!(stems.len(), XT_OUT_LEN);
        for s in 0..STEMS.len() {
            let stem = &stems[s * XT_LEN..(s + 1) * XT_LEN];
            assert!(stem.iter().all(|&v| v == s as f32 + 1.0), "stem {s}");
        }
    }

    #[test]
    fn prepare_gives_normalised_inputs_of_the_model_shapes() {
        let input = prepare(&stereo()).unwrap();
        assert_eq!(input.x.len(), X_LEN);
        assert_eq!(input.xt.len(), XT_LEN);
        let mean = input.xt.iter().map(|&v| f64::from(v)).sum::<f64>() / XT_LEN as f64;
        assert!(mean.abs() < 1e-4);
    }
}
