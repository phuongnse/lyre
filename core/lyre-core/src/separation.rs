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
//!
//! [`Separation`] runs these steps over a whole song. It cuts the audio into
//! overlapping windows, joins the windows' stems and checks the sum of the
//! result.

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
/// The samples between the starts of two windows. Windows overlap by a
/// quarter, as Demucs's `apply_model` does by default.
pub const WINDOW_STRIDE: usize = SEGMENT_SAMPLES - SEGMENT_SAMPLES / 4;
/// The least energy of the input over the energy of what the two tracks leave
/// out, in dB. The mark is provisional until the model measurement page (#111)
/// confirms or changes it. It guards against broken runs.
pub const MIN_ENERGY_DB: f64 = 10.0;
/// The most a track's peak may be above the input's own peak, in dB.
pub const MAX_PEAK_DB: f64 = 1.0;

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
    /// There is no audio to separate.
    NoAudio,
    /// The left and right channels differ in length.
    ChannelLengths { left: usize, right: usize },
    /// The window `index` does not exist, because there are `count` windows.
    WindowOutOfRange { index: usize, count: usize },
    /// The outputs of the window `index` came before its inputs were made.
    NoInput { index: usize },
    /// The window `index` has no outputs yet.
    WindowMissing { index: usize },
    /// The joined tracks failed the sum check.
    SumCheck(SumCheckFailure),
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
            SeparationError::NoAudio => write!(f, "there is no audio to separate"),
            SeparationError::ChannelLengths { left, right } => write!(
                f,
                "the left channel has {left} samples, but the right has {right}"
            ),
            SeparationError::WindowOutOfRange { index, count } => {
                write!(f, "window {index} does not exist, there are {count}")
            }
            SeparationError::NoInput { index } => {
                write!(f, "window {index} has outputs but no inputs were made")
            }
            SeparationError::WindowMissing { index } => {
                write!(f, "window {index} has no outputs yet")
            }
            SeparationError::SumCheck(failure) => failure.fmt(f),
        }
    }
}

/// The sum check rule a run failed, with the value measured.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SumCheckFailure {
    /// The input's energy over the leftover's energy was `db`, under
    /// [`MIN_ENERGY_DB`].
    Energy { db: f64 },
    /// The vocals peaked `db` above the input's peak, over [`MAX_PEAK_DB`].
    VocalsPeak { db: f64 },
    /// The karaoke track peaked `db` above the input's peak, over
    /// [`MAX_PEAK_DB`].
    KaraokePeak { db: f64 },
}

impl fmt::Display for SumCheckFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SumCheckFailure::Energy { db } => {
                write!(f, "the sum check failed the energy rule at {db:.1} dB")
            }
            SumCheckFailure::VocalsPeak { db } => write!(
                f,
                "the sum check failed the clipping rule: the vocals peak {db:.1} dB above the input"
            ),
            SumCheckFailure::KaraokePeak { db } => write!(
                f,
                "the sum check failed the clipping rule: the karaoke track peaks {db:.1} dB above the input"
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

/// The windows needed for `samples` samples per channel. A window starts
/// every [`WINDOW_STRIDE`] samples while its start is inside the audio, as
/// Demucs's `apply_model` does.
pub fn window_count(samples: usize) -> usize {
    samples.div_ceil(WINDOW_STRIDE)
}

/// Demucs's weight at position `i` of a window: a triangle that peaks in the
/// middle, scaled so that its peak is 1. It is never 0.
fn weight(i: usize) -> f64 {
    let half = SEGMENT_SAMPLES / 2;
    let w = if i < half { i + 1 } else { SEGMENT_SAMPLES - i };
    w as f64 / half as f64
}

/// What the sum check measured.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SumCheck {
    /// The input's energy over the energy of input - vocals - karaoke track,
    /// in dB. It is +∞ when nothing is left over.
    pub energy_db: f64,
    /// The vocals' peak over the input's peak, in dB. It is -∞ when the
    /// vocals are silent.
    pub vocals_peak_db: f64,
    /// The karaoke track's peak over the input's peak, in dB. It is -∞ when
    /// the track is silent.
    pub karaoke_peak_db: f64,
}

/// Measures the sum check of three planar tracks of the same length, over
/// both channels.
pub fn measure(input: &[f32], vocals: &[f32], karaoke: &[f32]) -> SumCheck {
    let mut input_energy = 0.0f64;
    let mut leftover_energy = 0.0f64;
    for ((&x, &v), &k) in input.iter().zip(vocals).zip(karaoke) {
        let x = f64::from(x);
        let left = x - f64::from(v) - f64::from(k);
        input_energy += x * x;
        leftover_energy += left * left;
    }
    let energy_db = if leftover_energy == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (input_energy / leftover_energy).log10()
    };
    let input_peak = peak(input);
    let peak_db = |track: &[f32]| {
        let track_peak = peak(track);
        if track_peak == 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * (track_peak / input_peak).log10()
        }
    };
    SumCheck {
        energy_db,
        vocals_peak_db: peak_db(vocals),
        karaoke_peak_db: peak_db(karaoke),
    }
}

fn peak(values: &[f32]) -> f64 {
    values
        .iter()
        .fold(0.0f64, |p, &v| p.max(f64::from(v).abs()))
}

/// Checks that the vocals and karaoke track add back up to the input, and do
/// not clip. The rules are checked in order: energy, vocals peak, karaoke
/// peak. The first one that fails is reported. A peak over 1.0 alone does not
/// fail, because decoded loud masters already exceed it.
pub fn sum_check(
    input: &[f32],
    vocals: &[f32],
    karaoke: &[f32],
) -> Result<SumCheck, SumCheckFailure> {
    let check = measure(input, vocals, karaoke);
    if check.energy_db.is_nan() || check.energy_db < MIN_ENERGY_DB {
        Err(SumCheckFailure::Energy {
            db: check.energy_db,
        })
    } else if check.vocals_peak_db > MAX_PEAK_DB {
        Err(SumCheckFailure::VocalsPeak {
            db: check.vocals_peak_db,
        })
    } else if check.karaoke_peak_db > MAX_PEAK_DB {
        Err(SumCheckFailure::KaraokePeak {
            db: check.karaoke_peak_db,
        })
    } else {
        Ok(check)
    }
}

/// The joined result of a separation.
#[derive(Debug, Clone, PartialEq)]
pub struct Tracks {
    /// The vocals: planar stereo, `2 * samples` values.
    pub vocals: Vec<f32>,
    /// The karaoke track: drums + bass + other, in the same layout.
    pub karaoke: Vec<f32>,
    pub check: SumCheck,
}

/// A separation of a whole song. It cuts the audio into windows, takes the
/// model's outputs for each, and joins them with Demucs's triangular weights.
/// Only the vocals and the karaoke track are kept while joining, because
/// joining is linear: the drums, bass and other stems are summed as each
/// window arrives.
///
/// Audio and tracks are planar: `[c * samples + n]`.
#[derive(Debug)]
pub struct Separation {
    samples: usize,
    audio: Vec<f32>,
    vocals: Vec<f32>,
    karaoke: Vec<f32>,
    norms: Vec<Option<(Normalisation, Normalisation)>>,
    done: Vec<bool>,
}

impl Separation {
    /// Starts a separation of 44.1 kHz stereo audio.
    pub fn new(left: &[f32], right: &[f32]) -> Result<Separation, SeparationError> {
        if left.len() != right.len() {
            return Err(SeparationError::ChannelLengths {
                left: left.len(),
                right: right.len(),
            });
        }
        let samples = left.len();
        if samples == 0 {
            return Err(SeparationError::NoAudio);
        }
        let count = window_count(samples);
        let mut audio = Vec::with_capacity(CHANNELS * samples);
        audio.extend_from_slice(left);
        audio.extend_from_slice(right);
        Ok(Separation {
            samples,
            audio,
            vocals: vec![0.0; CHANNELS * samples],
            karaoke: vec![0.0; CHANNELS * samples],
            norms: vec![None; count],
            done: vec![false; count],
        })
    }

    /// The number of windows.
    pub fn window_count(&self) -> usize {
        self.done.len()
    }

    fn check_index(&self, index: usize) -> Result<(), SeparationError> {
        if index < self.done.len() {
            Ok(())
        } else {
            Err(SeparationError::WindowOutOfRange {
                index,
                count: self.done.len(),
            })
        }
    }

    /// The audio of the window `index`: `XT_LEN` values, padded with silence
    /// past the end.
    pub fn window(&self, index: usize) -> Result<Vec<f32>, SeparationError> {
        self.check_index(index)?;
        let offset = index * WINDOW_STRIDE;
        let length = SEGMENT_SAMPLES.min(self.samples - offset);
        let mut window = vec![0.0f32; XT_LEN];
        for c in 0..CHANNELS {
            let from = c * self.samples + offset;
            window[c * SEGMENT_SAMPLES..c * SEGMENT_SAMPLES + length]
                .copy_from_slice(&self.audio[from..from + length]);
        }
        Ok(window)
    }

    /// The model's inputs for the window `index`.
    pub fn input(&mut self, index: usize) -> Result<ModelInput, SeparationError> {
        let input = prepare(&self.window(index)?)?;
        self.norms[index] = Some((input.x_norm.clone(), input.xt_norm.clone()));
        Ok(input)
    }

    /// Takes the model's outputs for the window `index`. Its inputs must have
    /// been made with [`Separation::input`].
    pub fn output(
        &mut self,
        index: usize,
        x_out: &[f32],
        xt_out: &[f32],
    ) -> Result<(), SeparationError> {
        self.check_index(index)?;
        let Some((x_norm, xt_norm)) = &self.norms[index] else {
            return Err(SeparationError::NoInput { index });
        };
        let stems = finish(x_norm, xt_norm, x_out, xt_out)?;
        self.add_stems(index, &stems)
    }

    /// Takes the four stems of the window `index`: `XT_OUT_LEN` values in the
    /// order of [`STEMS`].
    pub fn add_stems(&mut self, index: usize, stems: &[f32]) -> Result<(), SeparationError> {
        self.check_index(index)?;
        check_length("stems", XT_OUT_LEN, stems.len())?;
        let offset = index * WINDOW_STRIDE;
        let length = SEGMENT_SAMPLES.min(self.samples - offset);
        let stem =
            |s: usize, c: usize, n: usize| f64::from(stems[s * XT_LEN + c * SEGMENT_SAMPLES + n]);
        for c in 0..CHANNELS {
            for n in 0..length {
                let w = weight(n);
                let at = c * self.samples + offset + n;
                let others = stem(0, c, n) + stem(1, c, n) + stem(2, c, n);
                self.vocals[at] += (w * stem(3, c, n)) as f32;
                self.karaoke[at] += (w * others) as f32;
            }
        }
        self.done[index] = true;
        Ok(())
    }

    /// Joins the windows and checks the sum. Every window needs its outputs.
    pub fn finish(mut self) -> Result<Tracks, SeparationError> {
        if let Some(index) = self.done.iter().position(|&done| !done) {
            return Err(SeparationError::WindowMissing { index });
        }
        let count = self.done.len();
        for c in 0..CHANNELS {
            for n in 0..self.samples {
                // The windows that cover sample `n`: at most two.
                let last = (n / WINDOW_STRIDE).min(count - 1);
                let first = if n >= SEGMENT_SAMPLES {
                    (n - SEGMENT_SAMPLES) / WINDOW_STRIDE + 1
                } else {
                    0
                };
                let sum: f64 = (first..=last).map(|k| weight(n - k * WINDOW_STRIDE)).sum();
                let at = c * self.samples + n;
                self.vocals[at] = (f64::from(self.vocals[at]) / sum) as f32;
                self.karaoke[at] = (f64::from(self.karaoke[at]) / sum) as f32;
            }
        }
        let check = sum_check(&self.audio, &self.vocals, &self.karaoke)
            .map_err(SeparationError::SumCheck)?;
        Ok(Tracks {
            vocals: self.vocals,
            karaoke: self.karaoke,
            check,
        })
    }
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

    /// A deterministic stereo signal of `samples` samples per channel.
    fn song(samples: usize) -> (Vec<f32>, Vec<f32>) {
        let t = |n: usize| n as f64 / 44_100.0;
        let left = (0..samples)
            .map(|n| (0.5 * (2.0 * PI * 440.0 * t(n)).sin()) as f32)
            .collect();
        let right = (0..samples)
            .map(|n| (0.4 * (2.0 * PI * 330.0 * t(n)).sin() + 0.1 * (n % 7) as f64 / 7.0) as f32)
            .collect();
        (left, right)
    }

    /// Four stems that make `window` from scale factors: stem `s` is
    /// `scales[s]` times the window.
    fn stems_of(window: &[f32], scales: [f32; 4]) -> Vec<f32> {
        scales
            .iter()
            .flat_map(|&scale| window.iter().map(move |&v| v * scale))
            .collect()
    }

    #[test]
    fn windows_cut_and_joined_give_back_the_signal() {
        for (samples, windows) in [(100_000, 1), (SEGMENT_SAMPLES, 2), (700_000, 3)] {
            let (left, right) = song(samples);
            let mut separation = Separation::new(&left, &right).unwrap();
            assert_eq!(separation.window_count(), windows, "{samples} samples");
            for index in 0..windows {
                let window = separation.window(index).unwrap();
                separation
                    .add_stems(index, &stems_of(&window, [0.0, 0.0, 0.0, 1.0]))
                    .unwrap();
            }
            let original = separation.audio.clone();
            let tracks = separation.finish().expect("the sum check passes");
            assert_eq!(tracks.vocals.len(), 2 * samples);
            assert_eq!(tracks.karaoke.len(), 2 * samples);
            for (at, (&joined, &original)) in tracks.vocals.iter().zip(&original).enumerate() {
                assert!(
                    (joined - original).abs() <= 1e-6,
                    "{samples} samples, value {at}: {joined} against {original}"
                );
            }
        }
    }

    #[test]
    fn the_last_window_is_padded_with_silence() {
        let (left, right) = song(300_000);
        let separation = Separation::new(&left, &right).unwrap();
        assert_eq!(separation.window_count(), 2);
        let window = separation.window(1).unwrap();
        let length = 300_000 - WINDOW_STRIDE;
        assert_eq!(&window[..length], &left[WINDOW_STRIDE..]);
        assert!(window[length..SEGMENT_SAMPLES].iter().all(|&v| v == 0.0));
        assert_eq!(
            &window[SEGMENT_SAMPLES..SEGMENT_SAMPLES + length],
            &right[WINDOW_STRIDE..]
        );
    }

    #[test]
    fn windows_start_every_quarter_overlap_stride() {
        assert_eq!(WINDOW_STRIDE, 257_985);
        assert_eq!(window_count(1), 1);
        assert_eq!(window_count(WINDOW_STRIDE), 1);
        assert_eq!(window_count(WINDOW_STRIDE + 1), 2);
        assert_eq!(window_count(SEGMENT_SAMPLES), 2);
    }

    #[test]
    fn the_karaoke_track_is_drums_plus_bass_plus_other() {
        let (left, right) = song(100_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        let window = separation.window(0).unwrap();
        // Drums a, bass b, other c and vocals v.
        separation
            .add_stems(0, &stems_of(&window, [0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        let input = separation.audio.clone();
        // The sum check passes, because 0.4 + 0.6 = 1.
        let tracks = separation.finish().expect("the sum check passes");
        for (at, &x) in input.iter().enumerate() {
            assert!((tracks.vocals[at] - 0.4 * x).abs() <= 1e-6, "vocals {at}");
            assert!((tracks.karaoke[at] - 0.6 * x).abs() <= 1e-6, "karaoke {at}");
        }
    }

    fn sine(peak: f32) -> Vec<f32> {
        (0..20_000)
            .map(|n| peak * (2.0 * PI * 440.0 * n as f64 / 44_100.0).sin() as f32)
            .collect()
    }

    fn scaled(x: &[f32], by: f64) -> Vec<f32> {
        x.iter().map(|&v| (f64::from(v) * by) as f32).collect()
    }

    fn energy_case(db: f64) -> Result<SumCheck, SumCheckFailure> {
        let x = sine(0.5);
        let g = 10f64.powf(-db / 20.0);
        sum_check(&x, &scaled(&x, 0.5), &scaled(&x, 0.5 - g))
    }

    #[test]
    fn the_energy_rule_fails_at_9_9_db_and_passes_at_10_1_db() {
        match energy_case(9.9) {
            Err(SumCheckFailure::Energy { db }) => assert!((db - 9.9).abs() < 1e-3, "{db}"),
            other => panic!("{other:?}"),
        }
        let check = energy_case(10.1).expect("passes");
        assert!((check.energy_db - 10.1).abs() < 1e-3, "{}", check.energy_db);
    }

    /// Vocals `p` dB above the input's peak, and a karaoke track that makes
    /// up the rest. With `swap`, the roles are the other way round.
    fn clipping_case(p: f64, swap: bool) -> Result<SumCheck, SumCheckFailure> {
        // The input already exceeds 1.0.
        let x = sine(1.2);
        let loud = scaled(&x, 10f64.powf(p / 20.0));
        let rest: Vec<f32> = x.iter().zip(&loud).map(|(&a, &b)| a - b).collect();
        if swap {
            sum_check(&x, &rest, &loud)
        } else {
            sum_check(&x, &loud, &rest)
        }
    }

    #[test]
    fn the_clipping_rule_fails_1_1_db_above_the_input_and_passes_at_0_9_db() {
        match clipping_case(1.1, false) {
            Err(SumCheckFailure::VocalsPeak { db }) => assert!((db - 1.1).abs() < 1e-3, "{db}"),
            other => panic!("{other:?}"),
        }
        let check = clipping_case(0.9, false).expect("passes");
        assert!((check.vocals_peak_db - 0.9).abs() < 1e-3);
        match clipping_case(1.1, true) {
            Err(SumCheckFailure::KaraokePeak { db }) => assert!((db - 1.1).abs() < 1e-3, "{db}"),
            other => panic!("{other:?}"),
        }
        let check = clipping_case(0.9, true).expect("passes");
        assert!((check.karaoke_peak_db - 0.9).abs() < 1e-3);
    }

    #[test]
    fn silence_passes_the_sum_check() {
        let silent = vec![0.0f32; 1000];
        let check = sum_check(&silent, &silent, &silent).expect("passes");
        assert_eq!(check.energy_db, f64::INFINITY);
        assert_eq!(check.vocals_peak_db, f64::NEG_INFINITY);
        assert_eq!(check.karaoke_peak_db, f64::NEG_INFINITY);
    }

    #[test]
    fn a_failing_separation_names_the_rule() {
        let (left, right) = song(100_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        separation.add_stems(0, &vec![0.0; XT_OUT_LEN]).unwrap();
        match separation.finish() {
            Err(SeparationError::SumCheck(SumCheckFailure::Energy { db })) => {
                assert!(db.abs() < 1e-6, "{db}")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn steps_that_cannot_work_are_refused() {
        assert_eq!(
            Separation::new(&[], &[]).unwrap_err(),
            SeparationError::NoAudio
        );
        assert_eq!(
            Separation::new(&[0.0; 3], &[0.0; 2]).unwrap_err(),
            SeparationError::ChannelLengths { left: 3, right: 2 }
        );
        let mut separation = Separation::new(&[0.0; 10], &[0.0; 10]).unwrap();
        let out_of_range = SeparationError::WindowOutOfRange { index: 1, count: 1 };
        assert_eq!(separation.window(1).unwrap_err(), out_of_range);
        assert_eq!(separation.input(1).unwrap_err(), out_of_range);
        assert_eq!(
            separation.add_stems(1, &vec![0.0; XT_OUT_LEN]).unwrap_err(),
            out_of_range
        );
        assert_eq!(
            separation
                .output(1, &vec![0.0; X_OUT_LEN], &vec![0.0; XT_OUT_LEN])
                .unwrap_err(),
            out_of_range
        );
        assert_eq!(
            separation
                .output(0, &vec![0.0; X_OUT_LEN], &vec![0.0; XT_OUT_LEN])
                .unwrap_err(),
            SeparationError::NoInput { index: 0 }
        );
        assert_eq!(
            separation.add_stems(0, &[0.0; 5]).unwrap_err(),
            wrong("stems", XT_OUT_LEN, 5)
        );
        assert_eq!(
            separation.finish().unwrap_err(),
            SeparationError::WindowMissing { index: 0 }
        );
    }

    #[test]
    fn silent_audio_goes_through_the_model_steps() {
        let mut separation = Separation::new(&[0.0; 1000], &[0.0; 1000]).unwrap();
        let input = separation.input(0).unwrap();
        assert_eq!(input.xt.len(), XT_LEN);
        separation
            .output(0, &vec![0.0; X_OUT_LEN], &vec![0.0; XT_OUT_LEN])
            .unwrap();
        let tracks = separation.finish().unwrap();
        assert_eq!(tracks.vocals, vec![0.0; 2000]);
        assert_eq!(tracks.karaoke, vec![0.0; 2000]);
    }

    #[test]
    fn failure_messages_hold_only_numbers() {
        assert_eq!(
            SeparationError::SumCheck(SumCheckFailure::Energy { db: 9.94 }).to_string(),
            "the sum check failed the energy rule at 9.9 dB"
        );
        assert!(
            SeparationError::WindowMissing { index: 2 }
                .to_string()
                .contains("window 2")
        );
    }
}
