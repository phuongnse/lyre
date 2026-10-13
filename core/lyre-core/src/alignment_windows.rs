//! Aligner windows: the steps around a CTC aligner that cut a song into
//! windows and join the windows' frames.
//!
//! The aligners take 16 kHz mono audio in windows under 40 s (D15) and give
//! one frame per 320 samples. [`plan`] cuts a song into 30 s windows with 2 s
//! of overlap, each starting on the 20 ms frame grid. Each overlap is cut at
//! its middle, so every frame of the song comes from exactly one window. See
//! `docs/domain/knowledge.md`, under "Processing".
//!
//! [`AlignerWindows`] runs these steps over a whole song. It hands out each
//! window's audio, padded with silence to 30 s, takes the model's frames for
//! each window in order and joins them into `ceil(samples / 320)` frames for
//! [`alignment::align`]. It never pads or guesses frames.
//!
//! Frames are flat `f32` vectors, frame by frame: `frames × width` values,
//! where the width is the number of vocabulary entries.

use std::fmt;
use std::ops::Range;

use crate::alignment;

/// The samples in one frame: 20 ms at 16 kHz.
pub const SAMPLES_PER_FRAME: usize = 320;
/// The samples in one window: 30 s at 16 kHz.
pub const WINDOW_SAMPLES: usize = 480_000;
/// The samples two neighbouring windows share: 2 s at 16 kHz.
pub const OVERLAP_SAMPLES: usize = 32_000;
/// The frames 30 s can hold.
pub const WINDOW_FRAMES: usize = WINDOW_SAMPLES / SAMPLES_PER_FRAME;
/// The frames between the starts of two windows.
pub const STEP_FRAMES: usize = (WINDOW_SAMPLES - OVERLAP_SAMPLES) / SAMPLES_PER_FRAME;
/// The end, exclusive and counted within a window, of the frames any window
/// supplies: the middle of where the next overlap would be. A wav2vec2-style
/// aligner gives 1,499 frames for 30 s, so this leaves spare frames.
pub const USED_FRAMES: usize = STEP_FRAMES + (WINDOW_FRAMES - STEP_FRAMES) / 2;
/// The most samples accepted: as many as `alignment::MAX_FRAMES` frames hold.
pub const MAX_SAMPLES: usize = alignment::MAX_FRAMES * SAMPLES_PER_FRAME;

/// One window of the plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    /// The song sample the window starts at, a multiple of
    /// `SAMPLES_PER_FRAME`.
    pub start_sample: usize,
    /// The song's samples in the window. The rest of its `WINDOW_SAMPLES` is
    /// silence.
    pub audio_samples: usize,
    /// The song's frames this window supplies.
    pub frames: Range<usize>,
}

impl Window {
    /// The song frame the window's first frame is.
    pub fn first_frame(&self) -> usize {
        self.start_sample / SAMPLES_PER_FRAME
    }
}

/// How a song is cut into aligner windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowPlan {
    samples: usize,
    frames: usize,
    windows: Vec<Window>,
}

impl WindowPlan {
    /// The song's samples.
    pub fn samples(&self) -> usize {
        self.samples
    }

    /// The song's frames once joined: `ceil(samples / SAMPLES_PER_FRAME)`.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// The windows, in song order.
    pub fn windows(&self) -> &[Window] {
        &self.windows
    }
}

/// Plans the windows of a song `samples` long.
pub fn plan(samples: usize) -> Result<WindowPlan, WindowError> {
    if samples == 0 {
        return Err(WindowError::NoAudio);
    }
    let frames = samples.div_ceil(SAMPLES_PER_FRAME);
    if frames > alignment::MAX_FRAMES {
        return Err(WindowError::TooLong {
            frames,
            limit: alignment::MAX_FRAMES,
        });
    }
    let count = if frames <= USED_FRAMES {
        1
    } else {
        1 + (frames - USED_FRAMES).div_ceil(STEP_FRAMES)
    };
    // Window `k` supplies frames from the middle of the overlap with window
    // `k - 1` to the middle of the overlap with window `k + 1`.
    let range_start = |k: usize| {
        if k == 0 {
            0
        } else {
            k * STEP_FRAMES + (USED_FRAMES - STEP_FRAMES)
        }
    };
    let windows = (0..count)
        .map(|k| {
            let start_sample = k * STEP_FRAMES * SAMPLES_PER_FRAME;
            let end = if k + 1 == count {
                frames
            } else {
                range_start(k + 1)
            };
            Window {
                start_sample,
                audio_samples: WINDOW_SAMPLES.min(samples - start_sample),
                frames: range_start(k)..end,
            }
        })
        .collect();
    Ok(WindowPlan {
        samples,
        frames,
        windows,
    })
}

/// The aligner windows of a whole song. The caller gives the audio, runs the
/// model on each window's audio, gives back its frames in order, and finally
/// takes the joined frames.
#[derive(Debug)]
pub struct AlignerWindows {
    audio: Vec<f32>,
    plan: WindowPlan,
    width: usize,
    next: usize,
    joined: Vec<f32>,
}

impl AlignerWindows {
    /// Starts the windows of 16 kHz mono audio, for a model whose frames
    /// hold `width` values.
    pub fn new(samples: &[f32], width: usize) -> Result<AlignerWindows, WindowError> {
        let plan = plan(samples.len())?;
        if !(1..=alignment::MAX_VOCABULARY).contains(&width) {
            return Err(WindowError::VocabularyWidth { width });
        }
        Ok(AlignerWindows {
            audio: samples.to_vec(),
            plan,
            width,
            next: 0,
            joined: Vec::new(),
        })
    }

    /// The number of windows.
    pub fn window_count(&self) -> usize {
        self.plan.windows.len()
    }

    /// The plan the windows follow.
    pub fn plan(&self) -> &WindowPlan {
        &self.plan
    }

    /// The audio of the window `index`: `WINDOW_SAMPLES` values, padded with
    /// silence past the end of the song.
    pub fn window(&self, index: usize) -> Result<Vec<f32>, WindowError> {
        let Some(window) = self.plan.windows.get(index) else {
            return Err(WindowError::WindowOutOfRange {
                window: index,
                count: self.window_count(),
            });
        };
        let start = window.start_sample;
        let mut audio = vec![0.0f32; WINDOW_SAMPLES];
        audio[..window.audio_samples]
            .copy_from_slice(&self.audio[start..start + window.audio_samples]);
        Ok(audio)
    }

    /// Takes the model's frames for the window `index`: `log_probs` holds
    /// `frames × width` values, frame by frame. Windows must come in order.
    /// Only the frames the window supplies are kept.
    pub fn add_frames(&mut self, index: usize, log_probs: &[f32]) -> Result<(), WindowError> {
        // Once every window is in, no index is the next one.
        let Some(window) = self.plan.windows.get(index).filter(|_| index == self.next) else {
            return Err(WindowError::OutOfOrder { window: index });
        };
        if !log_probs.len().is_multiple_of(self.width) {
            return Err(WindowError::LogProbsLength {
                window: index,
                len: log_probs.len(),
                width: self.width,
            });
        }
        let frames = log_probs.len() / self.width;
        if frames > WINDOW_FRAMES {
            return Err(WindowError::TooManyFrames {
                window: index,
                frames,
                limit: WINDOW_FRAMES,
            });
        }
        let first = window.first_frame();
        let needed = window.frames.end - first;
        if frames < needed {
            return Err(WindowError::TooFewFrames {
                window: index,
                frames,
                needed,
            });
        }
        let from = (window.frames.start - first) * self.width;
        self.joined
            .extend_from_slice(&log_probs[from..needed * self.width]);
        self.next += 1;
        Ok(())
    }

    /// The joined frames: `plan().frames() × width` values. Every window
    /// needs its frames.
    pub fn finish(self) -> Result<Vec<f32>, WindowError> {
        if self.next < self.window_count() {
            return Err(WindowError::MissingWindows {
                given: self.next,
                expected: self.window_count(),
            });
        }
        Ok(self.joined)
    }
}

/// Why a step was refused. Windows count from 0. No message quotes any
/// values from the audio or the frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowError {
    /// There is no audio to align.
    NoAudio,
    /// The audio is `frames` frames long, over the limit of `limit`.
    TooLong { frames: usize, limit: usize },
    /// The frames' width is 0 or over `alignment::MAX_VOCABULARY`.
    VocabularyWidth { width: usize },
    /// The window `window` does not exist, because there are `count` windows.
    WindowOutOfRange { window: usize, count: usize },
    /// The window `window` is not the next one expected.
    OutOfOrder { window: usize },
    /// The window's `len` values are not a whole number of frames of `width`.
    LogProbsLength {
        window: usize,
        len: usize,
        width: usize,
    },
    /// The window has more frames than 30 s can hold.
    TooManyFrames {
        window: usize,
        frames: usize,
        limit: usize,
    },
    /// The window has fewer frames than the frames it supplies need.
    TooFewFrames {
        window: usize,
        frames: usize,
        needed: usize,
    },
    /// Only `given` of the `expected` windows have their frames.
    MissingWindows { given: usize, expected: usize },
}

impl fmt::Display for WindowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WindowError::NoAudio => write!(f, "there is no audio to align"),
            WindowError::TooLong { frames, limit } => write!(
                f,
                "the audio is {frames} frames long, over the limit of {limit}"
            ),
            WindowError::VocabularyWidth { width } => write!(
                f,
                "frames of {width} values are outside 1 to {} values",
                alignment::MAX_VOCABULARY
            ),
            WindowError::WindowOutOfRange { window, count } => {
                write!(f, "window {} does not exist, there are {count}", window + 1)
            }
            WindowError::OutOfOrder { window } => {
                write!(f, "window {} is not the next window expected", window + 1)
            }
            WindowError::LogProbsLength { window, len, width } => write!(
                f,
                "the {len} log-probabilities of window {} are not a whole number of frames of {width}",
                window + 1
            ),
            WindowError::TooManyFrames {
                window,
                frames,
                limit,
            } => write!(
                f,
                "window {} has {frames} frames, over the limit of {limit}",
                window + 1
            ),
            WindowError::TooFewFrames {
                window,
                frames,
                needed,
            } => write!(
                f,
                "window {} has {frames} frames, but {needed} are needed",
                window + 1
            ),
            WindowError::MissingWindows { given, expected } => write!(
                f,
                "only {given} of the {expected} windows have their frames"
            ),
        }
    }
}

impl std::error::Error for WindowError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The audio lengths every plan test checks.
    const LENGTHS: [usize; 7] = [1, 319, 320, 321, 480_000, 480_001, 9_600_000];

    /// The frames a wav2vec2-style aligner gives for 30 s.
    const MODEL_FRAMES: usize = 1_499;

    #[test]
    fn every_window_is_30_s_on_the_frame_grid_and_the_windows_cover_every_sample() {
        const { assert!(WINDOW_SAMPLES < 40 * 16_000) };
        for samples in LENGTHS {
            let plan = plan(samples).unwrap();
            let windows = plan.windows();
            assert_eq!(plan.samples(), samples);
            assert_eq!(windows[0].start_sample, 0, "{samples} samples");
            for (k, window) in windows.iter().enumerate() {
                assert_eq!(window.start_sample % SAMPLES_PER_FRAME, 0);
                assert_eq!(
                    window.audio_samples,
                    WINDOW_SAMPLES.min(samples - window.start_sample),
                    "{samples} samples, window {k}"
                );
                if k > 0 {
                    assert!(
                        window.start_sample < windows[k - 1].start_sample + WINDOW_SAMPLES,
                        "{samples} samples, window {k} leaves a gap"
                    );
                }
            }
            let last = windows.last().unwrap();
            assert!(last.start_sample + WINDOW_SAMPLES >= samples);
            assert_eq!(last.start_sample + last.audio_samples, samples);
        }
    }

    #[test]
    fn the_frame_ranges_tile_the_song_and_end_by_the_middle_of_the_next_overlap() {
        for samples in LENGTHS {
            let plan = plan(samples).unwrap();
            assert_eq!(plan.frames(), samples.div_ceil(320));
            let mut next = 0;
            for (k, window) in plan.windows().iter().enumerate() {
                let first = window.first_frame();
                assert_eq!(window.frames.start, next, "{samples} samples, window {k}");
                assert!(!window.frames.is_empty(), "{samples} samples, window {k}");
                assert!(window.frames.start >= first);
                assert!(window.frames.end <= first + USED_FRAMES);
                next = window.frames.end;
            }
            assert_eq!(next, plan.frames(), "{samples} samples");
        }
    }

    #[test]
    fn known_window_counts() {
        let windows = |samples| plan(samples).unwrap().windows().to_vec();
        assert_eq!(windows(320).len(), 1);
        let short = windows(321);
        assert_eq!(short.len(), 1);
        assert_eq!(short[0].frames, 0..2);
        let thirty = windows(480_000);
        assert_eq!(thirty.len(), 2);
        assert_eq!(thirty[0].frames, 0..1_450);
        assert_eq!(thirty[1].frames, 1_450..1_500);
        assert_eq!(thirty[1].start_sample, 448_000);
        assert_eq!(thirty[1].audio_samples, 32_000);
        assert_eq!(windows(9_600_000).len(), 22);
    }

    #[test]
    fn audio_over_the_frame_limit_or_empty_is_refused() {
        assert_eq!(MAX_SAMPLES, 57_600_000);
        assert_eq!(plan(MAX_SAMPLES).unwrap().frames(), 180_000);
        assert_eq!(
            plan(MAX_SAMPLES + 1),
            Err(WindowError::TooLong {
                frames: 180_001,
                limit: 180_000
            })
        );
        assert_eq!(plan(0), Err(WindowError::NoAudio));
        assert_eq!(
            AlignerWindows::new(&[], 2).unwrap_err(),
            WindowError::NoAudio
        );
    }

    #[test]
    fn each_window_is_its_audio_then_silence() {
        let audio: Vec<f32> = (0..480_001).map(|i| (i + 1) as f32).collect();
        let windows = AlignerWindows::new(&audio, 2).unwrap();
        let count = windows.window_count();
        assert_eq!(count, 2);
        for (k, window) in windows.plan().windows().iter().enumerate() {
            let values = windows.window(k).unwrap();
            assert_eq!(values.len(), WINDOW_SAMPLES);
            let start = window.start_sample;
            let real = window.audio_samples;
            assert_eq!(values[..real], audio[start..start + real], "window {k}");
            assert!(values[real..].iter().all(|&v| v == 0.0), "window {k}");
        }
        assert_eq!(
            windows.window(count),
            Err(WindowError::WindowOutOfRange {
                window: 2,
                count: 2
            })
        );
    }

    /// `frames` frames of width 2 for the window: local frame `j` holds
    /// `[g, -g]`, where `g` is its song frame.
    fn encoded(window: &Window, frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|j| {
                let g = (window.first_frame() + j) as f32;
                [g, -g]
            })
            .collect()
    }

    #[test]
    fn joining_gives_every_song_frame_once_from_its_own_window() {
        for samples in LENGTHS {
            let mut windows = AlignerWindows::new(&vec![0.0; samples], 2).unwrap();
            let plan = windows.plan().clone();
            for (k, window) in plan.windows().iter().enumerate() {
                windows
                    .add_frames(k, &encoded(window, MODEL_FRAMES))
                    .unwrap();
            }
            let joined = windows.finish().unwrap();
            let frames = samples.div_ceil(320);
            assert_eq!(joined.len(), 2 * frames, "{samples} samples");
            for g in 0..frames {
                assert_eq!(joined[2 * g], g as f32, "{samples} samples, frame {g}");
                assert_eq!(joined[2 * g + 1], -(g as f32));
            }
        }
    }

    /// The windows of 9,600,000 samples with width 2, and their plan.
    fn long_song() -> (AlignerWindows, WindowPlan) {
        let windows = AlignerWindows::new(&vec![0.0; 9_600_000], 2).unwrap();
        let plan = windows.plan().clone();
        (windows, plan)
    }

    /// The frames the window needs to supply its range.
    fn needed(window: &Window) -> usize {
        window.frames.end - window.first_frame()
    }

    #[test]
    fn a_window_one_frame_short_is_refused() {
        let (mut windows, plan) = long_song();
        let count = plan.windows().len();
        for k in 0..count {
            let window = &plan.windows()[k];
            if k == 1 || k == count - 1 {
                assert_eq!(
                    windows.add_frames(k, &encoded(window, needed(window) - 1)),
                    Err(WindowError::TooFewFrames {
                        window: k,
                        frames: needed(window) - 1,
                        needed: needed(window)
                    })
                );
            }
            windows
                .add_frames(k, &encoded(window, needed(window)))
                .unwrap();
        }
        assert_eq!(needed(&plan.windows()[1]), USED_FRAMES);
        assert_eq!(windows.finish().unwrap().len(), 2 * 30_000);
    }

    #[test]
    fn a_window_with_more_frames_than_30_s_hold_is_refused() {
        let (mut windows, plan) = long_song();
        assert_eq!(
            windows.add_frames(0, &encoded(&plan.windows()[0], 1_501)),
            Err(WindowError::TooManyFrames {
                window: 0,
                frames: 1_501,
                limit: 1_500
            })
        );
        assert!(
            windows
                .add_frames(0, &encoded(&plan.windows()[0], 1_500))
                .is_ok()
        );
    }

    #[test]
    fn frames_that_are_not_a_whole_number_of_the_width_are_refused() {
        let (mut windows, _) = long_song();
        assert_eq!(
            windows.add_frames(0, &[0.0; 2 * 1_499 + 1]),
            Err(WindowError::LogProbsLength {
                window: 0,
                len: 2_999,
                width: 2
            })
        );
    }

    #[test]
    fn windows_out_of_order_are_refused() {
        let (mut windows, plan) = long_song();
        let frames = |k: usize| encoded(&plan.windows()[k], MODEL_FRAMES);
        assert_eq!(
            windows.add_frames(1, &frames(1)),
            Err(WindowError::OutOfOrder { window: 1 })
        );
        windows.add_frames(0, &frames(0)).unwrap();
        assert_eq!(
            windows.add_frames(0, &frames(0)),
            Err(WindowError::OutOfOrder { window: 0 })
        );
        let count = plan.windows().len();
        for k in 1..count {
            windows.add_frames(k, &frames(k)).unwrap();
        }
        assert_eq!(
            windows.add_frames(count, &frames(count - 1)),
            Err(WindowError::OutOfOrder { window: count })
        );
        assert_eq!(windows.finish().unwrap().len(), 2 * 30_000);
    }

    #[test]
    fn finishing_before_every_window_is_refused() {
        let (mut windows, plan) = long_song();
        windows
            .add_frames(0, &encoded(&plan.windows()[0], MODEL_FRAMES))
            .unwrap();
        assert_eq!(
            windows.finish(),
            Err(WindowError::MissingWindows {
                given: 1,
                expected: 22
            })
        );
    }

    #[test]
    fn a_width_of_0_or_over_the_vocabulary_limit_is_refused() {
        assert_eq!(
            AlignerWindows::new(&[0.0], 0).unwrap_err(),
            WindowError::VocabularyWidth { width: 0 }
        );
        assert_eq!(
            AlignerWindows::new(&[0.0], alignment::MAX_VOCABULARY + 1).unwrap_err(),
            WindowError::VocabularyWidth { width: 16_385 }
        );
        assert!(AlignerWindows::new(&[0.0], alignment::MAX_VOCABULARY).is_ok());
    }

    #[test]
    fn messages_number_windows_from_1() {
        assert_eq!(
            WindowError::TooFewFrames {
                window: 0,
                frames: 1,
                needed: 2
            }
            .to_string(),
            "window 1 has 1 frames, but 2 are needed"
        );
        assert_eq!(
            WindowError::OutOfOrder { window: 2 }.to_string(),
            "window 3 is not the next window expected"
        );
    }
}
