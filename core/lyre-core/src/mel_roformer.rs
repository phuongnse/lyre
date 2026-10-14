//! Mel-Band RoFormer: the steps around Kim's separator that its file leaves
//! out. See `docs/reference/models.md#mel-band-roformer`.
//!
//! Before the model, [`spectrogram`] turns one 8 s stereo segment into the
//! model's input. After the model, [`waveform`] turns its output, the vocals'
//! spectrogram, back into the segment's vocals. [`Separation`] runs these over
//! a whole song: it cuts the song into overlapping segments, joins their
//! vocals with linear fades, makes the karaoke track as the source minus the
//! vocals and applies the broken-run check ([`broken_run_check`]).
//!
//! Arrays are flat `f32` vectors in the model's row-major tensor layout,
//! without the batch dimension. The arithmetic inside runs in `f64`.
//!
//! - A stereo segment: `[c * SEGMENT_SAMPLES + n]`.
//! - The spectrogram: `[(k * BINS + bin) * FRAMES + frame]`, where `k = 2 * c`
//!   holds the real part and `k = 2 * c + 1` the imaginary part, in the order
//!   left real, left imaginary, right real, right imaginary.

use std::f64::consts::PI;
use std::fmt;

use crate::fft::Fft;

/// The channels of a segment: stereo.
pub const CHANNELS: usize = 2;
/// The samples per channel in one segment: 8 s at 44.1 kHz.
pub const SEGMENT_SAMPLES: usize = 352_800;
/// The samples between the starts of two segments: 4 s.
pub const SEGMENT_STEP: usize = 176_400;
/// The samples in a fade between two segments: 0.8 s.
pub const FADE_SAMPLES: usize = 35_280;
/// The length of each FFT frame, and of the Hann window.
pub const N_FFT: usize = 2048;
/// The samples between two FFT frames.
pub const HOP: usize = 441;
/// The frequency bins in the model's input: `N_FFT / 2 + 1`.
pub const BINS: usize = 1025;
/// The time frames in the model's input: `SEGMENT_SAMPLES / HOP + 1`.
pub const FRAMES: usize = 801;
/// The values in a segment.
pub const SEGMENT_LEN: usize = CHANNELS * SEGMENT_SAMPLES;
/// The values in a spectrogram: four channels of `BINS` by `FRAMES`.
pub const SPEC_LEN: usize = 4 * BINS * FRAMES;
/// The most the vocals' peak may be above the source's own peak, in dB. Six dB
/// is a chosen safety margin, not an industry standard.
pub const MAX_VOCALS_PEAK_DB: f64 = 6.0;

/// The smallest window envelope that torch's inverse STFT accepts.
const MIN_ENVELOPE: f64 = 1e-11;

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
    /// The segment `index` does not exist, because there are `count` segments.
    SegmentOutOfRange { index: usize, count: usize },
    /// The segment `index` has no vocals yet.
    SegmentMissing { index: usize },
    /// The joined tracks failed the broken-run check.
    BrokenRun(BrokenRun),
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
            SeparationError::SegmentOutOfRange { index, count } => {
                write!(f, "segment {index} does not exist, there are {count}")
            }
            SeparationError::SegmentMissing { index } => {
                write!(f, "segment {index} has no vocals yet")
            }
            SeparationError::BrokenRun(failure) => failure.fmt(f),
        }
    }
}

impl std::error::Error for SeparationError {}

/// The broken-run rule a run failed, with the value measured.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BrokenRun {
    /// The vocals' sample `at` is NaN or infinite.
    VocalsNotFinite { at: usize },
    /// The karaoke track's sample `at` is NaN or infinite.
    KaraokeNotFinite { at: usize },
    /// The vocals peaked `db` above the source's peak, over
    /// [`MAX_VOCALS_PEAK_DB`].
    VocalsPeak { db: f64 },
}

impl fmt::Display for BrokenRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BrokenRun::VocalsNotFinite { at } => write!(
                f,
                "the broken-run check failed the not-finite rule: vocals sample {at} is not finite"
            ),
            BrokenRun::KaraokeNotFinite { at } => write!(
                f,
                "the broken-run check failed the not-finite rule: karaoke track sample {at} is not finite"
            ),
            BrokenRun::VocalsPeak { db } => write!(
                f,
                "the broken-run check failed the peak rule: the vocals peak {db:.1} dB above the source"
            ),
        }
    }
}

/// What the broken-run check measured.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RunCheck {
    /// The vocals' peak over the source's peak, in dB. It is -∞ when the
    /// vocals are silent.
    pub vocals_peak_db: f64,
    /// The karaoke track's peak over the source's peak, in dB. It is -∞ when
    /// the track is silent.
    pub karaoke_peak_db: f64,
}

/// Checks three planar tracks of the same length. The rules are checked in
/// order: vocals not finite, karaoke track not finite, vocals peak. The first
/// one that fails is reported. A peak over 1.0 alone does not fail, because
/// decoded loud masters already exceed it. The karaoke track has no peak rule,
/// because where vocals and music partly cancel in the mix, the music alone can
/// go above the mix's peak.
pub fn broken_run_check(
    source: &[f32],
    vocals: &[f32],
    karaoke: &[f32],
) -> Result<RunCheck, BrokenRun> {
    if let Some(at) = vocals.iter().position(|v| !v.is_finite()) {
        return Err(BrokenRun::VocalsNotFinite { at });
    }
    if let Some(at) = karaoke.iter().position(|v| !v.is_finite()) {
        return Err(BrokenRun::KaraokeNotFinite { at });
    }
    let source_peak = peak(source);
    let peak_db = |track: &[f32]| {
        let track_peak = peak(track);
        if track_peak == 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * (track_peak / source_peak).log10()
        }
    };
    let check = RunCheck {
        vocals_peak_db: peak_db(vocals),
        karaoke_peak_db: peak_db(karaoke),
    };
    if check.vocals_peak_db > MAX_VOCALS_PEAK_DB {
        Err(BrokenRun::VocalsPeak {
            db: check.vocals_peak_db,
        })
    } else {
        Ok(check)
    }
}

fn peak(values: &[f32]) -> f64 {
    values
        .iter()
        .fold(0.0f64, |p, &v| p.max(f64::from(v).abs()))
}

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

/// The model's input for a segment of `SEGMENT_LEN` values: the STFT of each
/// channel, centred with reflect padding and not normalised. It has
/// `SPEC_LEN` values.
pub fn spectrogram(segment: &[f32]) -> Result<Vec<f32>, SeparationError> {
    check_length("segment", SEGMENT_LEN, segment.len())?;
    let fft = Fft::new(N_FFT);
    let window = hann();
    let mut out = vec![0.0f32; SPEC_LEN];
    let mut re = vec![0.0f64; N_FFT];
    let mut im = vec![0.0f64; N_FFT];
    for c in 0..CHANNELS {
        let channel = &segment[c * SEGMENT_SAMPLES..(c + 1) * SEGMENT_SAMPLES];
        let channel: Vec<f64> = channel.iter().map(|&v| f64::from(v)).collect();
        let padded = reflect_pad(&channel, N_FFT / 2, N_FFT / 2);
        for frame in 0..FRAMES {
            let start = frame * HOP;
            for (n, ((r, i), w)) in re.iter_mut().zip(&mut im).zip(&window).enumerate() {
                *r = padded[start + n] * w;
                *i = 0.0;
            }
            fft.transform(&mut re, &mut im, false);
            for (bin, (&r, &i)) in re.iter().zip(&im).take(BINS).enumerate() {
                out[((2 * c) * BINS + bin) * FRAMES + frame] = r as f32;
                out[((2 * c + 1) * BINS + bin) * FRAMES + frame] = i as f32;
            }
        }
    }
    Ok(out)
}

/// The stereo waveform of a spectrogram of `SPEC_LEN` values, by the inverse
/// STFT. It has `SEGMENT_LEN` values.
pub fn waveform(spec: &[f32]) -> Result<Vec<f32>, SeparationError> {
    check_length("spectrogram", SPEC_LEN, spec.len())?;
    let fft = Fft::new(N_FFT);
    let window = hann();
    let length = (FRAMES - 1) * HOP + N_FFT;
    // The window's squares, summed over all frames.
    let mut envelope = vec![0.0f64; length];
    for t in 0..FRAMES {
        for (e, w) in envelope[t * HOP..].iter_mut().zip(&window) {
            *e += w * w;
        }
    }
    let mut out = vec![0.0f32; SEGMENT_LEN];
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
                let r = f64::from(spec[((2 * c) * BINS + bin) * FRAMES + frame]);
                // The inverse real FFT ignores the imaginary parts of the
                // first and last bins.
                let i = if bin == 0 || bin == BINS - 1 {
                    0.0
                } else {
                    f64::from(spec[((2 * c + 1) * BINS + bin) * FRAMES + frame])
                };
                re[bin] = r;
                im[bin] = i;
                if bin > 0 && bin < BINS - 1 {
                    re[N_FFT - bin] = r;
                    im[N_FFT - bin] = -i;
                }
            }
            fft.transform(&mut re, &mut im, true);
            for ((s, &r), w) in signal[frame * HOP..].iter_mut().zip(&re).zip(&window) {
                *s += r * w;
            }
        }
        // Drop the centring.
        for (n, v) in channel.iter_mut().enumerate() {
            let at = N_FFT / 2 + n;
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

/// The joined result of a separation.
#[derive(Debug, Clone, PartialEq)]
pub struct Tracks {
    /// The vocals: planar stereo, `2 * samples` values.
    pub vocals: Vec<f32>,
    /// The karaoke track, the source minus the vocals, in the same layout.
    pub karaoke: Vec<f32>,
    pub check: RunCheck,
}

/// A separation of a whole song. It cuts the audio into segments, takes the
/// model's output for each, and joins the vocals with linear fades.
///
/// The song is reflected at both ends, by [`SEGMENT_STEP`] samples, unless it
/// lasts 8 s or less. The segments start every [`SEGMENT_STEP`] samples of
/// that padded song. The first segment has no fade-in and the last has no
/// fade-out. A last part shorter than a segment is padded by reflection when
/// it is longer than half a segment, and with silence otherwise.
///
/// Audio and tracks are planar: `[c * samples + n]`.
#[derive(Debug)]
pub struct Separation {
    samples: usize,
    audio: Vec<f32>,
    /// The samples reflected at each end.
    border: usize,
    padded_len: usize,
    vocals: Vec<f32>,
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
        let border = if samples > 2 * SEGMENT_STEP {
            SEGMENT_STEP
        } else {
            0
        };
        let padded_len = samples + 2 * border;
        let mut audio = Vec::with_capacity(CHANNELS * samples);
        audio.extend_from_slice(left);
        audio.extend_from_slice(right);
        Ok(Separation {
            samples,
            audio,
            border,
            padded_len,
            vocals: vec![0.0; CHANNELS * samples],
            done: vec![false; padded_len.div_ceil(SEGMENT_STEP)],
        })
    }

    /// The number of segments.
    pub fn segment_count(&self) -> usize {
        self.done.len()
    }

    fn check_index(&self, index: usize) -> Result<(), SeparationError> {
        if index < self.done.len() {
            Ok(())
        } else {
            Err(SeparationError::SegmentOutOfRange {
                index,
                count: self.done.len(),
            })
        }
    }

    /// The sample at position `p` of the padded song in channel `c`.
    fn padded_at(&self, c: usize, p: usize) -> f32 {
        let j = p as isize - self.border as isize;
        let last = self.samples as isize - 1;
        let j = if j < 0 {
            -j
        } else if j > last {
            2 * last - j
        } else {
            j
        };
        self.audio[c * self.samples + j as usize]
    }

    /// The samples of the segment `index` that lie inside the padded song.
    fn segment_len(&self, index: usize) -> usize {
        SEGMENT_SAMPLES.min(self.padded_len - index * SEGMENT_STEP)
    }

    /// The audio of the segment `index`: `SEGMENT_LEN` values. A last part
    /// shorter than a segment is padded as the type's documentation says.
    pub fn segment(&self, index: usize) -> Result<Vec<f32>, SeparationError> {
        self.check_index(index)?;
        let start = index * SEGMENT_STEP;
        let len = self.segment_len(index);
        let mut segment = vec![0.0f32; SEGMENT_LEN];
        for c in 0..CHANNELS {
            let part = &mut segment[c * SEGMENT_SAMPLES..(c + 1) * SEGMENT_SAMPLES];
            for (n, v) in part[..len].iter_mut().enumerate() {
                *v = self.padded_at(c, start + n);
            }
            if len < SEGMENT_SAMPLES && len > SEGMENT_SAMPLES / 2 {
                for j in 0..SEGMENT_SAMPLES - len {
                    part[len + j] = part[len - 2 - j];
                }
            }
        }
        Ok(segment)
    }

    /// The model's input for the segment `index`.
    pub fn input(&self, index: usize) -> Result<Vec<f32>, SeparationError> {
        spectrogram(&self.segment(index)?)
    }

    /// Takes the model's output for the segment `index`: the vocals'
    /// spectrogram of `SPEC_LEN` values.
    pub fn output(&mut self, index: usize, spec_out: &[f32]) -> Result<(), SeparationError> {
        self.check_index(index)?;
        let vocals = waveform(spec_out)?;
        self.add_vocals(index, &vocals)
    }

    /// The weight at position `n` of the segment `index`: 1, with a linear
    /// fade-in on every segment but the first and a linear fade-out on every
    /// segment but the last.
    fn weight(&self, index: usize, n: usize) -> f64 {
        let mut w = 1.0;
        if index > 0 && n < FADE_SAMPLES {
            w = n as f64 / (FADE_SAMPLES - 1) as f64;
        }
        if index + 1 < self.done.len() && n >= SEGMENT_SAMPLES - FADE_SAMPLES {
            w = w.min((SEGMENT_SAMPLES - 1 - n) as f64 / (FADE_SAMPLES - 1) as f64);
        }
        w
    }

    /// Takes the vocals of the segment `index`: `SEGMENT_LEN` values.
    pub fn add_vocals(&mut self, index: usize, vocals: &[f32]) -> Result<(), SeparationError> {
        self.check_index(index)?;
        check_length("vocals", SEGMENT_LEN, vocals.len())?;
        let start = index * SEGMENT_STEP;
        let len = self.segment_len(index);
        for n in 0..len {
            let p = start + n;
            if p < self.border || p >= self.border + self.samples {
                continue;
            }
            let w = self.weight(index, n);
            for c in 0..CHANNELS {
                let at = c * self.samples + p - self.border;
                let v = f64::from(vocals[c * SEGMENT_SAMPLES + n]);
                self.vocals[at] += (w * v) as f32;
            }
        }
        self.done[index] = true;
        Ok(())
    }

    /// Joins the segments, makes the karaoke track and applies the broken-run
    /// check. Every segment needs its vocals.
    pub fn finish(mut self) -> Result<Tracks, SeparationError> {
        if let Some(index) = self.done.iter().position(|&done| !done) {
            return Err(SeparationError::SegmentMissing { index });
        }
        let count = self.done.len();
        for p in self.border..self.border + self.samples {
            // The segments that cover position `p`: at most two.
            let last = (p / SEGMENT_STEP).min(count - 1);
            let first = if p >= SEGMENT_SAMPLES {
                (p - SEGMENT_SAMPLES) / SEGMENT_STEP + 1
            } else {
                0
            };
            let sum: f64 = (first..=last)
                .map(|k| self.weight(k, p - k * SEGMENT_STEP))
                .sum();
            for c in 0..CHANNELS {
                let at = c * self.samples + p - self.border;
                self.vocals[at] = if sum > 0.0 {
                    (f64::from(self.vocals[at]) / sum) as f32
                } else {
                    0.0
                };
            }
        }
        let karaoke: Vec<f32> = self
            .audio
            .iter()
            .zip(&self.vocals)
            .map(|(&x, &v)| (f64::from(x) - f64::from(v)) as f32)
            .collect();
        let check = broken_run_check(&self.audio, &self.vocals, &karaoke)
            .map_err(SeparationError::BrokenRun)?;
        Ok(Tracks {
            vocals: self.vocals,
            karaoke,
            check,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo() -> Vec<f32> {
        let t = |n: usize| n as f64 / 44_100.0;
        let mut segment = Vec::with_capacity(SEGMENT_LEN);
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

    /// A deterministic stereo signal of `samples` samples per channel, never
    /// silent.
    fn song(samples: usize) -> (Vec<f32>, Vec<f32>) {
        let t = |n: usize| n as f64 / 44_100.0;
        let left = (0..samples)
            .map(|n| (0.5 * (2.0 * PI * 440.0 * t(n)).sin() + 0.25) as f32)
            .collect();
        let right = (0..samples)
            .map(|n| (0.4 * (2.0 * PI * 330.0 * t(n)).sin() + 0.1 * (n % 7) as f64 / 7.0) as f32)
            .collect();
        (left, right)
    }

    /// The value of bin `bin` at frame `frame` of `torch.stft` with n_fft 2048,
    /// hop 441, a periodic Hann window of 2048 and `center=True` with reflect
    /// padding: the sum over `n` of `w[n] * x[frame * hop + n - 1024] *
    /// exp(-2πi * bin * n / 2048)`, where `x` is reflected at its ends.
    fn direct_dft(channel: &[f32], frame: usize, bin: usize) -> (f64, f64) {
        let last = channel.len() as isize - 1;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for n in 0..2048usize {
            let w = (PI * n as f64 / 2048.0).sin().powi(2);
            let mut j = (frame * 441 + n) as isize - 1024;
            if j < 0 {
                j = -j;
            }
            if j > last {
                j = 2 * last - j;
            }
            let x = f64::from(channel[j as usize]);
            let angle = 2.0 * PI * ((bin * n) % 2048) as f64 / 2048.0;
            re += w * x * angle.cos();
            im -= w * x * angle.sin();
        }
        (re, im)
    }

    #[test]
    fn the_spectrogram_matches_a_direct_dft_of_the_stft_definition() {
        let segment = stereo();
        let spec = spectrogram(&segment).unwrap();
        assert_eq!(spec.len(), 4 * 1025 * 801);
        for c in 0..CHANNELS {
            let channel = &segment[c * SEGMENT_SAMPLES..(c + 1) * SEGMENT_SAMPLES];
            for frame in [0, 400, 800] {
                for bin in [0, 1, 100, 1023, 1024] {
                    let (re, im) = direct_dft(channel, frame, bin);
                    let got_re = f64::from(spec[((2 * c) * BINS + bin) * FRAMES + frame]);
                    let got_im = f64::from(spec[((2 * c + 1) * BINS + bin) * FRAMES + frame]);
                    assert!(
                        (got_re - re).abs() <= 1e-3 && (got_im - im).abs() <= 1e-3,
                        "channel {c} frame {frame} bin {bin}: ({got_re}, {got_im}) against ({re}, {im})"
                    );
                }
            }
        }
    }

    #[test]
    fn the_inverse_stft_gives_back_every_sample() {
        let segment = stereo();
        let back = waveform(&spectrogram(&segment).unwrap()).unwrap();
        assert_eq!(back.len(), SEGMENT_LEN);
        for (at, (&b, &s)) in back.iter().zip(&segment).enumerate() {
            assert!((b - s).abs() <= 1e-5, "value {at}: {b} against {s}");
        }
    }

    #[test]
    fn wrong_lengths_are_refused() {
        let wrong = |what, expected, actual| SeparationError::WrongLength {
            what,
            expected,
            actual,
        };
        for len in [SEGMENT_LEN - 1, SEGMENT_LEN + 1] {
            assert_eq!(
                spectrogram(&vec![0.0; len]),
                Err(wrong("segment", SEGMENT_LEN, len))
            );
        }
        for len in [SPEC_LEN - 1, SPEC_LEN + 1] {
            assert_eq!(
                waveform(&vec![0.0; len]),
                Err(wrong("spectrogram", SPEC_LEN, len))
            );
        }
        let mut separation = Separation::new(&[0.0; 10], &[0.0; 10]).unwrap();
        assert_eq!(
            separation.add_vocals(0, &[0.0; 5]).unwrap_err(),
            wrong("vocals", SEGMENT_LEN, 5)
        );
        assert_eq!(
            wrong("segment", 705_600, 5).to_string(),
            "the segment has 5 values, but 705600 are expected"
        );
    }

    #[test]
    fn segments_cut_and_joined_give_back_the_source() {
        for samples in [
            1, 2, 1000, 176_400, 176_401, 352_799, 352_800, 352_801, 529_201, 1_000_000,
        ] {
            let (left, right) = song(samples);
            let mut separation = Separation::new(&left, &right).unwrap();
            for index in 0..separation.segment_count() {
                let segment = separation.segment(index).unwrap();
                separation.add_vocals(index, &segment).unwrap();
            }
            let source = separation.audio.clone();
            let tracks = separation
                .finish()
                .unwrap_or_else(|e| panic!("{samples} samples: {e}"));
            assert_eq!(tracks.vocals.len(), 2 * samples);
            assert_eq!(tracks.karaoke.len(), 2 * samples);
            for (at, (&joined, &original)) in tracks.vocals.iter().zip(&source).enumerate() {
                assert!(
                    (joined - original).abs() <= 1e-6,
                    "{samples} samples, value {at}: {joined} against {original}"
                );
            }
            for (at, &k) in tracks.karaoke.iter().enumerate() {
                assert!(k.abs() <= 1e-6, "{samples} samples, karaoke {at}: {k}");
            }
        }
    }

    #[test]
    fn a_short_song_is_one_padded_segment_cut_back_to_its_own_length() {
        let (left, right) = song(100_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        assert_eq!(separation.segment_count(), 1);
        let segment = separation.segment(0).unwrap();
        assert_eq!(segment.len(), 352_800 * 2);
        assert_eq!(&segment[..100_000], &left[..]);
        assert!(segment[100_000..SEGMENT_SAMPLES].iter().all(|&v| v == 0.0));
        assert_eq!(
            &segment[SEGMENT_SAMPLES..SEGMENT_SAMPLES + 100_000],
            &right[..]
        );
        assert!(
            segment[SEGMENT_SAMPLES + 100_000..]
                .iter()
                .all(|&v| v == 0.0)
        );
        separation.add_vocals(0, &segment).unwrap();
        let tracks = separation.finish().unwrap();
        assert_eq!(tracks.vocals.len(), 2 * 100_000);
        assert_eq!(tracks.karaoke.len(), 2 * 100_000);
    }

    #[test]
    fn a_short_part_is_reflected_over_half_a_segment_and_silent_otherwise() {
        // 300,000 samples is one part of 300,000, over half a segment.
        let (left, right) = song(300_000);
        let separation = Separation::new(&left, &right).unwrap();
        assert_eq!(separation.segment_count(), 2);
        let first = separation.segment(0).unwrap();
        assert_eq!(&first[..300_000], &left[..]);
        // The rest reflects about the last sample, without repeating it.
        for j in [0, 1, 1000, SEGMENT_SAMPLES - 300_000 - 1] {
            assert_eq!(first[300_000 + j], left[300_000 - 2 - j], "offset {j}");
        }
        // The second part, 123,600 samples, is under half a segment.
        let second = separation.segment(1).unwrap();
        assert_eq!(&second[..123_600], &left[SEGMENT_STEP..]);
        assert!(second[123_600..SEGMENT_SAMPLES].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn the_first_segment_starts_with_the_reflection() {
        let (left, _) = song(1_000_000);
        let separation = Separation::new(&left, &left).unwrap();
        let segment = separation.segment(0).unwrap();
        assert_eq!(segment[0], left[176_400]);
        assert_eq!(segment[176_400], left[0]);
        assert_eq!(segment[176_401], left[1]);
        assert_eq!(segment[176_399], left[1]);
        // The song ends at padded position 1,176,400, inside segment 6, which
        // starts at 1,058,400. The reflection follows.
        assert_eq!(separation.segment_count(), 8);
        let sixth = separation.segment(6).unwrap();
        assert_eq!(sixth[118_000 - 1], left[999_999]);
        assert_eq!(sixth[118_000], left[999_998]);
        assert_eq!(sixth[118_000 + 100], left[999_898]);
    }

    #[test]
    fn the_fades_are_linear() {
        let samples = 1_000_000;
        let source = vec![1.0f32; samples];
        let mut separation = Separation::new(&source, &source).unwrap();
        let ones = vec![1.0f32; SEGMENT_LEN];
        let zeros = vec![0.0f32; SEGMENT_LEN];
        for index in 0..separation.segment_count() {
            let vocals = if index == 0 { &ones } else { &zeros };
            separation.add_vocals(index, vocals).unwrap();
        }
        let tracks = separation.finish().unwrap();
        // Padded position `p` is the song's sample `p - 176,400`.
        for j in [0, 1, 17_640, FADE_SAMPLES - 1] {
            let w0 = (FADE_SAMPLES - 1 - j) as f64 / (FADE_SAMPLES - 1) as f64;
            let p = SEGMENT_SAMPLES - FADE_SAMPLES + j;
            let got = f64::from(tracks.vocals[p - SEGMENT_STEP]);
            assert!(
                (got - w0 / (w0 + 1.0)).abs() <= 1e-6,
                "fade position {j}: {got} against {}",
                w0 / (w0 + 1.0)
            );
        }
        // At the start of the second segment its fade-in weighs 0, so only the
        // first segment counts.
        assert_eq!(tracks.vocals[0], 1.0);
        // Before the fade-out both segments weigh 1, and only one has vocals.
        assert_eq!(
            tracks.vocals[SEGMENT_SAMPLES - FADE_SAMPLES - 1 - SEGMENT_STEP],
            0.5
        );
    }

    #[test]
    fn a_whole_pass_through_the_steps_gives_back_the_source() {
        let (left, right) = song(441_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        assert_eq!(separation.segment_count(), 5);
        for index in 0..separation.segment_count() {
            // The model's output is the input, unchanged.
            let spec = separation.input(index).unwrap();
            assert_eq!(spec.len(), SPEC_LEN);
            separation.output(index, &spec).unwrap();
        }
        let source = separation.audio.clone();
        let tracks = separation.finish().unwrap();
        for (at, (&joined, &original)) in tracks.vocals.iter().zip(&source).enumerate() {
            assert!(
                (joined - original).abs() <= 1e-4,
                "value {at}: {joined} against {original}"
            );
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
        let out_of_range = SeparationError::SegmentOutOfRange { index: 1, count: 1 };
        assert_eq!(separation.segment(1).unwrap_err(), out_of_range);
        assert_eq!(separation.input(1).unwrap_err(), out_of_range);
        assert_eq!(
            separation
                .add_vocals(1, &vec![0.0; SEGMENT_LEN])
                .unwrap_err(),
            out_of_range
        );
        assert_eq!(
            separation.output(1, &vec![0.0; SPEC_LEN]).unwrap_err(),
            out_of_range
        );
        assert_eq!(
            separation.finish().unwrap_err(),
            SeparationError::SegmentMissing { index: 0 }
        );
    }

    fn sine(peak: f32) -> Vec<f32> {
        (0..20_000)
            .map(|n| peak * (2.0 * PI * 440.0 * n as f64 / 44_100.0).sin() as f32)
            .collect()
    }

    fn scaled(x: &[f32], by: f64) -> Vec<f32> {
        x.iter().map(|&v| (f64::from(v) * by) as f32).collect()
    }

    #[test]
    fn a_sample_that_is_not_finite_fails_the_not_finite_rule_with_its_position() {
        let x = sine(0.5);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut vocals = scaled(&x, 0.5);
            vocals[12] = bad;
            let karaoke = scaled(&x, 0.5);
            let failure = broken_run_check(&x, &vocals, &karaoke).unwrap_err();
            assert_eq!(failure, BrokenRun::VocalsNotFinite { at: 12 });
            assert_eq!(
                failure.to_string(),
                "the broken-run check failed the not-finite rule: vocals sample 12 is not finite"
            );
            let failure = broken_run_check(&x, &karaoke, &vocals).unwrap_err();
            assert_eq!(failure, BrokenRun::KaraokeNotFinite { at: 12 });
            assert_eq!(
                failure.to_string(),
                "the broken-run check failed the not-finite rule: karaoke track sample 12 is not finite"
            );
        }
    }

    /// Vocals `p` dB above the source's peak, and a karaoke track that makes
    /// up the rest.
    fn peak_case(p: f64) -> Result<RunCheck, BrokenRun> {
        // The source already exceeds 1.0.
        let x = sine(1.2);
        let loud = scaled(&x, 10f64.powf(p / 20.0));
        let rest: Vec<f32> = x.iter().zip(&loud).map(|(&a, &b)| a - b).collect();
        broken_run_check(&x, &loud, &rest)
    }

    #[test]
    fn the_vocals_peak_rule_fails_6_1_db_above_the_source_and_passes_at_5_9_db() {
        match peak_case(6.1) {
            Err(BrokenRun::VocalsPeak { db }) => assert!((db - 6.1).abs() < 1e-3, "{db}"),
            other => panic!("{other:?}"),
        }
        let check = peak_case(5.9).expect("passes");
        assert!((check.vocals_peak_db - 5.9).abs() < 1e-3);
    }

    #[test]
    fn a_karaoke_track_10_db_above_the_source_passes() {
        let x = sine(1.0);
        let vocals = scaled(&x, 0.5);
        let karaoke = scaled(&x, 10f64.powf(10.0 / 20.0));
        let check = broken_run_check(&x, &vocals, &karaoke).expect("passes");
        assert!(
            (check.karaoke_peak_db - 10.0).abs() < 1e-3,
            "{}",
            check.karaoke_peak_db
        );
    }

    #[test]
    fn silence_passes_the_broken_run_check() {
        let silent = vec![0.0f32; 1000];
        let check = broken_run_check(&silent, &silent, &silent).expect("passes");
        assert_eq!(check.vocals_peak_db, f64::NEG_INFINITY);
        assert_eq!(check.karaoke_peak_db, f64::NEG_INFINITY);
    }

    #[test]
    fn a_broken_separation_names_the_rule() {
        let (left, right) = song(100_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        let mut vocals = vec![0.0f32; SEGMENT_LEN];
        vocals[7] = f32::NAN;
        separation.add_vocals(0, &vocals).unwrap();
        assert_eq!(
            separation.finish().unwrap_err(),
            SeparationError::BrokenRun(BrokenRun::VocalsNotFinite { at: 7 })
        );
    }

    #[test]
    fn the_karaoke_track_is_the_source_minus_the_vocals() {
        let (left, right) = song(100_000);
        let mut separation = Separation::new(&left, &right).unwrap();
        let segment = separation.segment(0).unwrap();
        let vocals: Vec<f32> = segment.iter().map(|&v| 0.4 * v).collect();
        separation.add_vocals(0, &vocals).unwrap();
        let source = separation.audio.clone();
        let tracks = separation.finish().unwrap();
        for (at, &x) in source.iter().enumerate() {
            assert!((tracks.vocals[at] - 0.4 * x).abs() <= 1e-6, "vocals {at}");
            assert!((tracks.karaoke[at] - 0.6 * x).abs() <= 1e-6, "karaoke {at}");
        }
    }
}
