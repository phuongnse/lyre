//! WebAssembly bindings of the Lyre core, for the web client.

use lyre_core::access::{self, AccessFileError};
use lyre_core::aligner;
use lyre_core::alignment::{self, AlignmentError, Emissions};
use lyre_core::alignment_windows::{self, WindowError};
use lyre_core::countdown;
use lyre_core::device::{self, DeviceKeyError};
use lyre_core::display_lines::{self, DisplayLine, MeasuredSyllable};
use lyre_core::highlight;
use lyre_core::lyrics::Lyrics;
use lyre_core::lyrics_rows;
use lyre_core::mel_roformer::{self, BrokenRun, SeparationError};
use lyre_core::model;
use lyre_core::song_file::{
    self, Chunk, ChunkType, Header, Index, IndexEntry, Next, PieceWriter, SegmentPlan, SongDetails,
    SongFileError, SongPlan, SyllableTime, Timing, TrackPlan, v1,
};
use lyre_core::timing_file::{self, TimingErrorKind, TimingFileError};
use wasm_bindgen::prelude::wasm_bindgen;
use zeroize::Zeroize;

/// The version of the Lyre core.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
}

/// The stored type D24 gives a source track, from Mediabunny's name for its
/// codec and its codec string. Undefined when the track cannot be stored.
#[wasm_bindgen(js_name = storedType)]
pub fn stored_type(codec: &str, parameters: &str) -> Option<String> {
    song_file::stored_type(codec, parameters)
}

/// Why a song file was refused.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SongFileFaultKind {
    /// Too short for a header, or with the wrong magic.
    NotASongFile = 1,
    /// Damaged or incomplete.
    Damaged = 2,
    /// A version-0 file, offered to the encrypted open.
    OldVersion = 3,
    /// The access file is missing, invalid, for another device or for another
    /// song, or the header, the index or a chunk does not authenticate.
    CannotOpen = 4,
}

/// Why a song file was refused. It holds no core message, because those are
/// not meant for users, and no key bytes.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SongFileFault {
    kind: SongFileFaultKind,
}

#[wasm_bindgen]
impl SongFileFault {
    /// The kind of refusal.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> SongFileFaultKind {
        self.kind
    }

    /// True when the file is not a song file at all: too short for a header
    /// or with the wrong magic. False when it is damaged or incomplete.
    #[wasm_bindgen(getter, js_name = notASongFile)]
    pub fn not_a_song_file(&self) -> bool {
        self.kind == SongFileFaultKind::NotASongFile
    }
}

impl From<SongFileError> for SongFileFault {
    fn from(error: SongFileError) -> SongFileFault {
        let kind = match error {
            SongFileError::HeaderTooShort { .. } | SongFileError::BadMagic => {
                SongFileFaultKind::NotASongFile
            }
            SongFileError::UnsupportedVersion { version: 0 } => SongFileFaultKind::OldVersion,
            SongFileError::HeaderTag | SongFileError::ChunkTag { .. } => {
                SongFileFaultKind::CannotOpen
            }
            _ => SongFileFaultKind::Damaged,
        };
        SongFileFault { kind }
    }
}

impl From<AccessFileError> for SongFileFault {
    fn from(_: AccessFileError) -> SongFileFault {
        SongFileFault {
            kind: SongFileFaultKind::CannotOpen,
        }
    }
}

/// The fault for a file that is damaged or incomplete.
const DAMAGED: SongFileFault = SongFileFault {
    kind: SongFileFaultKind::Damaged,
};

/// The format version of a header, from its first ten bytes. Fewer bytes, or
/// the wrong magic, is not a song file.
fn header_version(bytes: &[u8]) -> Result<u16, SongFileFault> {
    match bytes.first_chunk::<10>() {
        Some(start) if start[..8] == song_file::MAGIC => {
            Ok(u16::from_le_bytes([start[8], start[9]]))
        }
        _ => Err(SongFileFaultKind::NotASongFile.into()),
    }
}

impl From<SongFileFaultKind> for SongFileFault {
    fn from(kind: SongFileFaultKind) -> SongFileFault {
        SongFileFault { kind }
    }
}

/// The type of a chunk, with the numbers the song file stores.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    SongDetails = 1,
    Thumbnail = 2,
    Lyrics = 3,
    Timing = 4,
    VideoInit = 16,
    VideoSegment = 17,
    KaraokeInit = 18,
    KaraokeSegment = 19,
    OriginalInit = 20,
    OriginalSegment = 21,
}

impl From<ChunkType> for ChunkKind {
    fn from(chunk_type: ChunkType) -> ChunkKind {
        match chunk_type {
            ChunkType::SongDetails => ChunkKind::SongDetails,
            ChunkType::Thumbnail => ChunkKind::Thumbnail,
            ChunkType::Lyrics => ChunkKind::Lyrics,
            ChunkType::Timing => ChunkKind::Timing,
            ChunkType::VideoInit => ChunkKind::VideoInit,
            ChunkType::VideoSegment => ChunkKind::VideoSegment,
            ChunkType::KaraokeInit => ChunkKind::KaraokeInit,
            ChunkType::KaraokeSegment => ChunkKind::KaraokeSegment,
            ChunkType::OriginalInit => ChunkKind::OriginalInit,
            ChunkType::OriginalSegment => ChunkKind::OriginalSegment,
        }
    }
}

/// One checked index entry: where a chunk is stored and, for a media
/// segment, when it plays.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkEntry {
    pub kind: ChunkKind,
    pub offset: u32,
    pub length: u32,
    #[wasm_bindgen(js_name = startMs)]
    pub start_ms: u32,
    #[wasm_bindgen(js_name = durationMs)]
    pub duration_ms: u32,
}

impl TryFrom<&IndexEntry> for ChunkEntry {
    type Error = SongFileFault;

    fn try_from(entry: &IndexEntry) -> Result<ChunkEntry, SongFileFault> {
        // A checked index ends within MAX_FILE_SIZE, 2³² − 1, so offsets fit.
        Ok(ChunkEntry {
            kind: entry.chunk_type.into(),
            offset: u32::try_from(entry.offset).map_err(|_| DAMAGED)?,
            length: entry.length,
            start_ms: entry.start_ms,
            duration_ms: entry.duration_ms,
        })
    }
}

/// Who sings the song, with the numbers the song file stores.
#[wasm_bindgen(js_name = VocalRole)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Male = 1,
    Female = 2,
}

impl From<song_file::VocalRole> for Role {
    fn from(role: song_file::VocalRole) -> Role {
        match role {
            song_file::VocalRole::Male => Role::Male,
            song_file::VocalRole::Female => Role::Female,
        }
    }
}

/// The song's title, artist and composer, exactly as the song file stores
/// them, and its vocal role. An empty artist or composer means not known.
#[wasm_bindgen(js_name = SongDetails)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Details {
    #[wasm_bindgen(getter_with_clone)]
    pub title: String,
    #[wasm_bindgen(getter_with_clone)]
    pub artist: String,
    #[wasm_bindgen(getter_with_clone)]
    pub composer: String,
    #[wasm_bindgen(js_name = vocalRole)]
    pub vocal_role: Role,
}

impl From<&SongDetails> for Details {
    fn from(details: &SongDetails) -> Details {
        Details {
            title: details.title().to_owned(),
            artist: details.artist().to_owned(),
            composer: details.composer().to_owned(),
            vocal_role: details.vocal_role().into(),
        }
    }
}

/// One syllable of the lyrics, with its timing. The text is exactly as the
/// lyrics store it (D5).
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LyricSyllable {
    #[wasm_bindgen(getter_with_clone)]
    pub text: String,
    /// The exact text between the previous syllable of the same lyric line
    /// and this one. It is empty for a lyric line's first syllable.
    #[wasm_bindgen(getter_with_clone)]
    pub separator: String,
    /// The index of the syllable's lyric line.
    #[wasm_bindgen(js_name = lyricLine)]
    pub lyric_line: u32,
    #[wasm_bindgen(js_name = startMs)]
    pub start_ms: u32,
    #[wasm_bindgen(js_name = endMs)]
    pub end_ms: u32,
}

/// A display line: the syllables `start..end` of one lyric line. The
/// indices count every syllable of the lyrics, in order.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplayLineSpan {
    #[wasm_bindgen(js_name = lyricLine)]
    pub lyric_line: u32,
    pub start: u32,
    pub end: u32,
}

/// The display lines the two rows of the Lyrics area show. Each is a
/// position in the list [`SongReader::lay_out`] returned, or nothing for an
/// empty row.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LyricsRows {
    pub top: Option<u32>,
    pub bottom: Option<u32>,
}

/// When one aligned syllable is sung, and how sure the model is of it, from
/// 0 to 1.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AlignedSyllable {
    #[wasm_bindgen(js_name = startMs)]
    pub start_ms: u32,
    #[wasm_bindgen(js_name = endMs)]
    pub end_ms: u32,
    pub confidence: f32,
}

/// Why alignment failed. It holds no core message, because those are not
/// meant for users. A syllable with no character the model knows has its
/// place. Any other failure has none.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignmentFault {
    lyric_line: Option<u32>,
    syllable: Option<u32>,
}

#[wasm_bindgen]
impl AlignmentFault {
    /// The index of the unknown syllable's lyric line, counting from 0.
    #[wasm_bindgen(getter, js_name = lyricLine)]
    pub fn lyric_line(&self) -> Option<u32> {
        self.lyric_line
    }

    /// The unknown syllable's position within its lyric line, counting
    /// from 0.
    #[wasm_bindgen(getter)]
    pub fn syllable(&self) -> Option<u32> {
        self.syllable
    }
}

impl From<AlignmentError> for AlignmentFault {
    fn from(error: AlignmentError) -> AlignmentFault {
        match error {
            // Lyrics are at most 1 MiB, so every index fits.
            AlignmentError::UnknownSyllable {
                lyric_line,
                position,
            } => AlignmentFault {
                lyric_line: Some(lyric_line as u32),
                syllable: Some(position as u32),
            },
            _ => REJECTED,
        }
    }
}

/// The fault for a failure with no syllable to name.
const REJECTED: AlignmentFault = AlignmentFault {
    lyric_line: None,
    syllable: None,
};

/// Times every syllable of `lyrics` from a CTC model's output for the whole
/// song: `log_probs` holds `frames × vocabulary.length` natural-log
/// probabilities, frame by frame. `blank` is the blank token's index,
/// `frame_us` the frame length in microseconds, `vocals` the 16 kHz mono
/// vocals the model ran on, which tell where the singing stops, and `song_ms`
/// the song's duration. It returns one time per syllable, in lyric order.
#[wasm_bindgen]
pub fn align(
    lyrics: &[u8],
    log_probs: &[f32],
    vocabulary: Vec<String>,
    blank: u32,
    frame_us: u32,
    vocals: &[f32],
    song_ms: u32,
) -> Result<Vec<AlignedSyllable>, AlignmentFault> {
    let lyrics = Lyrics::parse(lyrics).map_err(|_| REJECTED)?;
    let emissions = Emissions {
        log_probs,
        vocabulary: &vocabulary,
        blank: blank as usize,
        frame_us,
    };
    let alignment = alignment::align(&lyrics, &emissions, vocals, song_ms)?;
    Ok(alignment
        .timing
        .syllables()
        .iter()
        .zip(alignment.confidence)
        .map(|(time, confidence)| AlignedSyllable {
            start_ms: time.start_ms,
            end_ms: time.end_ms,
            confidence,
        })
        .collect())
}

/// Why an aligner window step was refused. It holds no core message, because
/// those are not meant for users. A refusal about one window names it. Any
/// other refusal has none.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowFault {
    window: Option<u32>,
}

#[wasm_bindgen]
impl WindowFault {
    /// The index of the window at fault, counting from 0.
    #[wasm_bindgen(getter)]
    pub fn window(&self) -> Option<u32> {
        self.window
    }
}

impl From<WindowError> for WindowFault {
    fn from(error: WindowError) -> WindowFault {
        let window = match error {
            WindowError::WindowOutOfRange { window, .. }
            | WindowError::OutOfOrder { window }
            | WindowError::LogProbsLength { window, .. }
            | WindowError::TooManyFrames { window, .. }
            | WindowError::TooFewFrames { window, .. } => Some(window),
            _ => None,
        };
        // Every index came from JavaScript as a u32, so it fits.
        WindowFault {
            window: window.map(|w| u32::try_from(w).unwrap_or(u32::MAX)),
        }
    }
}

/// The fault for a refusal with no window to name.
const NO_WINDOW: WindowFault = WindowFault { window: None };

/// The sample rate of the audio an aligner takes, in hertz.
const ALIGNER_SAMPLE_RATE: u64 = 16_000;

/// The aligner windows of a whole song. The client gives the 16 kHz mono
/// audio, runs the model on each window's audio, gives back its frames in
/// order, and finally takes the joined frames for `align`.
#[wasm_bindgen]
pub struct AlignerWindows {
    /// Gone once `finish` has taken it.
    windows: Option<alignment_windows::AlignerWindows>,
}

#[wasm_bindgen]
impl AlignerWindows {
    /// Starts the windows of 16 kHz mono audio, for a model whose frames
    /// hold `width` values: one per vocabulary entry.
    #[wasm_bindgen(constructor)]
    pub fn new(samples: &[f32], width: u32) -> Result<AlignerWindows, WindowFault> {
        Ok(AlignerWindows {
            windows: Some(alignment_windows::AlignerWindows::new(
                samples,
                width as usize,
            )?),
        })
    }

    /// The number of windows, or 0 once finished.
    #[wasm_bindgen(getter, js_name = windowCount)]
    pub fn window_count(&self) -> u32 {
        self.windows
            .as_ref()
            // At most 129 windows fit the frame limit, so the count fits.
            .map_or(0, |w| u32::try_from(w.window_count()).unwrap_or(u32::MAX))
    }

    /// The length of one frame in microseconds: 20 ms at 16 kHz. It is the
    /// `frame_us` that `align` takes, and stays the same once finished.
    #[wasm_bindgen(getter, js_name = frameUs)]
    pub fn frame_us(&self) -> u32 {
        // 320 samples at 16 kHz is 20,000 µs, so it fits.
        (alignment_windows::SAMPLES_PER_FRAME as u64 * 1_000_000 / ALIGNER_SAMPLE_RATE) as u32
    }

    /// The audio of the window `index`: 480,000 samples (30 s), padded with
    /// silence past the end of the song.
    pub fn window(&self, index: u32) -> Result<Vec<f32>, WindowFault> {
        let windows = self.windows.as_ref().ok_or(NO_WINDOW)?;
        Ok(windows.window(index as usize)?)
    }

    /// Takes the model's frames for the window `index`: `frames × width`
    /// values, frame by frame. Windows must come in order.
    #[wasm_bindgen(js_name = addFrames)]
    pub fn add_frames(&mut self, index: u32, log_probs: &[f32]) -> Result<(), WindowFault> {
        let windows = self.windows.as_mut().ok_or(NO_WINDOW)?;
        Ok(windows.add_frames(index as usize, log_probs)?)
    }

    /// The joined frames of the whole song: `ceil(samples / 320) × width`
    /// values. This ends the session, also when it is refused.
    pub fn finish(&mut self) -> Result<Vec<f32>, WindowFault> {
        let windows = self.windows.take().ok_or(NO_WINDOW)?;
        Ok(windows.finish()?)
    }
}

/// A candidate aligner (D20).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignerKind {
    LyricAlignment = 1,
}

impl From<AlignerKind> for aligner::AlignerKind {
    fn from(kind: AlignerKind) -> aligner::AlignerKind {
        match kind {
            AlignerKind::LyricAlignment => aligner::AlignerKind::LyricAlignment,
        }
    }
}

/// How an aligner takes its input and gives its output: the model's input
/// and output names.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignerRules {
    #[wasm_bindgen(getter_with_clone, js_name = inputName)]
    pub input_name: String,
    #[wasm_bindgen(getter_with_clone, js_name = outputName)]
    pub output_name: String,
}

/// An aligner's vocabulary: its tokens by index, and the blank's index.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignerVocabulary {
    #[wasm_bindgen(getter_with_clone)]
    pub tokens: Vec<String>,
    pub blank: u32,
}

/// The input and output rules of the aligner `kind`.
#[wasm_bindgen(js_name = alignerRules)]
pub fn aligner_rules(kind: AlignerKind) -> AlignerRules {
    let kind = aligner::AlignerKind::from(kind);
    AlignerRules {
        input_name: kind.input_name().to_owned(),
        output_name: kind.output_name().to_owned(),
    }
}

/// The natural-log probabilities from the aligner's output: frames of
/// `width` values, frame by frame. Undefined when the output is not whole
/// frames of `width`.
#[wasm_bindgen(js_name = alignerLogProbs)]
pub fn aligner_log_probs(kind: AlignerKind, output: &[f32], width: u32) -> Option<Vec<f32>> {
    aligner::AlignerKind::from(kind)
        .log_probs(output, width as usize)
        .ok()
}

/// Reads the aligner's vocabulary file, `vocab.json`. Undefined when the file
/// is refused.
#[wasm_bindgen(js_name = readVocabulary)]
pub fn read_vocabulary(kind: AlignerKind, bytes: &[u8]) -> Option<AlignerVocabulary> {
    let vocabulary = aligner::AlignerKind::from(kind)
        .read_vocabulary(bytes)
        .ok()?;
    Some(AlignerVocabulary {
        tokens: vocabulary.tokens,
        // A vocabulary has at most 16,384 entries, so the index fits.
        blank: u32::try_from(vocabulary.blank).unwrap_or(u32::MAX),
    })
}

/// One syllable's start and end in a hand-written timing file.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimedSyllable {
    #[wasm_bindgen(js_name = startMs)]
    pub start_ms: u32,
    #[wasm_bindgen(js_name = endMs)]
    pub end_ms: u32,
}

/// The rule a timing file broke, or `Lyrics` when the lyrics it is read
/// against are not valid.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingFileErrorKind {
    Lyrics,
    Malformed,
    UnknownSyllable,
    MissingSyllable,
    Backwards,
    Overlap,
}

/// Why a timing file was refused: the line, counting from 1, and the rule
/// it broke. It holds no core message and never the lyric text.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimingFileFault {
    line: Option<u32>,
    kind: TimingFileErrorKind,
}

#[wasm_bindgen]
impl TimingFileFault {
    /// The line that broke a rule. There is none when the lyrics are not
    /// valid.
    #[wasm_bindgen(getter)]
    pub fn line(&self) -> Option<u32> {
        self.line
    }

    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> TimingFileErrorKind {
        self.kind
    }
}

impl From<TimingFileError> for TimingFileFault {
    fn from(error: TimingFileError) -> TimingFileFault {
        let kind = match error.kind {
            TimingErrorKind::Malformed => TimingFileErrorKind::Malformed,
            TimingErrorKind::UnknownSyllable { .. } => TimingFileErrorKind::UnknownSyllable,
            TimingErrorKind::MissingSyllable { .. } => TimingFileErrorKind::MissingSyllable,
            TimingErrorKind::Backwards => TimingFileErrorKind::Backwards,
            TimingErrorKind::Overlap => TimingFileErrorKind::Overlap,
        };
        TimingFileFault {
            // A line is at most the file's length plus 1, and WebAssembly
            // memory holds under 4 GiB, so it fits.
            line: Some(u32::try_from(error.line).unwrap_or(u32::MAX)),
            kind,
        }
    }
}

/// Whether `lyrics` are valid lyrics. The lyrics are only read, never changed (D5).
#[wasm_bindgen(js_name = isValidLyrics)]
pub fn is_valid_lyrics(lyrics: &[u8]) -> bool {
    Lyrics::parse(lyrics).is_ok()
}

/// Reads the hand-written timing file `text` against `lyrics`, both as
/// bytes. It returns one time per syllable of the lyrics, in lyric order.
#[wasm_bindgen(js_name = parseTimingFile)]
pub fn parse_timing_file(
    text: &[u8],
    lyrics: &[u8],
) -> Result<Vec<TimedSyllable>, TimingFileFault> {
    let lyrics = Lyrics::parse(lyrics).map_err(|_| TimingFileFault {
        line: None,
        kind: TimingFileErrorKind::Lyrics,
    })?;
    let times = timing_file::parse(text, &lyrics)?;
    Ok(times
        .iter()
        .map(|time| TimedSyllable {
            start_ms: time.start_ms,
            end_ms: time.end_ms,
        })
        .collect())
}

/// The rule a timing broke in the song file's timing check, or `Lyrics`
/// when the lyrics it is checked against are not valid.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingCheckErrorKind {
    Lyrics,
    /// The times are not a valid timing: not start and end pairs, none at
    /// all, a syllable that does not start before it ends, or an overlap.
    Times,
    SyllableCount,
    PastEnd,
}

/// Why a timing was refused by the song file's timing check. It holds no
/// core message and never the lyric text.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimingCheckFault {
    kind: TimingCheckErrorKind,
}

#[wasm_bindgen]
impl TimingCheckFault {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> TimingCheckErrorKind {
        self.kind
    }
}

impl From<SongFileError> for TimingCheckFault {
    fn from(error: SongFileError) -> TimingCheckFault {
        let kind = match error {
            SongFileError::SyllableMismatch { .. } => TimingCheckErrorKind::SyllableCount,
            SongFileError::TimingPastEnd { .. } => TimingCheckErrorKind::PastEnd,
            _ => TimingCheckErrorKind::Times,
        };
        TimingCheckFault { kind }
    }
}

/// Runs the song file's timing check on a timing against `lyrics` and the
/// song's duration `song_ms`. `times_ms` holds each syllable's start and
/// end, in lyric order.
#[wasm_bindgen(js_name = checkTiming)]
pub fn check_timing(times_ms: &[u32], lyrics: &[u8], song_ms: u32) -> Result<(), TimingCheckFault> {
    let lyrics = Lyrics::parse(lyrics).map_err(|_| TimingCheckFault {
        kind: TimingCheckErrorKind::Lyrics,
    })?;
    let (pairs, rest) = times_ms.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(TimingCheckFault {
            kind: TimingCheckErrorKind::Times,
        });
    }
    let syllables = pairs
        .iter()
        .map(|&[start_ms, end_ms]| SyllableTime { start_ms, end_ms })
        .collect();
    let timing = Timing::new(syllables)?;
    Ok(song_file::check_timing(&timing, &lyrics, song_ms)?)
}

/// One of a song's media tracks.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video = 0,
    Karaoke = 1,
    Original = 2,
}

/// The part of a song that the song file writer refused.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SongWriteErrorKind {
    /// The title, artist or composer: a title that is empty, a field over
    /// 1,024 bytes, or one that holds a NUL character.
    Details,
    /// The lyrics are not valid lyrics.
    Lyrics,
    /// The times are not a valid timing: not start and end pairs, none at
    /// all, a syllable that does not start before it ends, or an overlap.
    Times,
    SyllableCount,
    /// The last syllable ends after the song.
    PastEnd,
    /// The song ID, a track or the thumbnail breaks a rule of the format.
    Media,
}

/// Why the song file writer refused a song. It holds no core message and
/// never the lyric text.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SongWriteFault {
    kind: SongWriteErrorKind,
}

#[wasm_bindgen]
impl SongWriteFault {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> SongWriteErrorKind {
        self.kind
    }
}

impl From<SongWriteErrorKind> for SongWriteFault {
    fn from(kind: SongWriteErrorKind) -> SongWriteFault {
        SongWriteFault { kind }
    }
}

impl From<SongFileError> for SongWriteFault {
    fn from(error: SongFileError) -> SongWriteFault {
        let kind = match error {
            SongFileError::SyllableMismatch { .. } => SongWriteErrorKind::SyllableCount,
            SongFileError::TimingPastEnd { .. } => SongWriteErrorKind::PastEnd,
            SongFileError::FieldLength { .. } | SongFileError::FieldNul { .. } => {
                SongWriteErrorKind::Details
            }
            _ => SongWriteErrorKind::Media,
        };
        SongWriteFault { kind }
    }
}

impl From<Role> for song_file::VocalRole {
    fn from(role: Role) -> song_file::VocalRole {
        match role {
            Role::Male => song_file::VocalRole::Male,
            Role::Female => song_file::VocalRole::Female,
        }
    }
}

/// What [`SongWriter::next_chunk`] says comes next in the song file.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextChunk {
    /// A chunk that the core makes. Take it with [`SongWriter::core_chunk`].
    Core,
    /// The next video media segment. Give its bytes to
    /// [`SongWriter::segment`].
    VideoSegment,
    KaraokeSegment,
    OriginalSegment,
    /// Every chunk has been written.
    End,
}

/// Collects the parts of one song, then gives the song file out in pieces
/// through the core's writer, so the client never lays out song file bytes.
/// The media segments are planned by length. [`SongWriter::start`] runs every
/// check on the plan and gives the header and index. The chunks follow in file
/// order, and only one media segment at a time passes through the writer. The
/// lyrics are kept exactly as supplied (D5).
#[wasm_bindgen]
pub struct SongWriter {
    song_id: Vec<u8>,
    title: String,
    artist: String,
    composer: String,
    vocal_role: Role,
    lyrics: Vec<u8>,
    times_ms: Vec<u32>,
    thumbnail: Option<Vec<u8>>,
    video: Option<TrackPlan>,
    karaoke: TrackPlan,
    original: TrackPlan,
    writer: Option<PieceWriter>,
    /// A chunk the core made, found by `next_chunk` and not yet taken.
    pending: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl SongWriter {
    /// Starts a song from its 16-byte `song_id`, its details, its `lyrics`
    /// as bytes, and `times_ms`, each syllable's start and end in lyric
    /// order. An empty artist or composer means not known.
    #[wasm_bindgen(constructor)]
    pub fn new(
        song_id: &[u8],
        title: String,
        artist: String,
        composer: String,
        vocal_role: Role,
        lyrics: &[u8],
        times_ms: &[u32],
    ) -> SongWriter {
        SongWriter {
            song_id: song_id.to_vec(),
            title,
            artist,
            composer,
            vocal_role,
            lyrics: lyrics.to_vec(),
            times_ms: times_ms.to_vec(),
            thumbnail: None,
            video: None,
            karaoke: TrackPlan::default(),
            original: TrackPlan::default(),
            writer: None,
            pending: None,
        }
    }

    /// Sets the thumbnail's JPEG bytes.
    #[wasm_bindgen(js_name = setThumbnail)]
    pub fn set_thumbnail(&mut self, bytes: &[u8]) {
        self.thumbnail = Some(bytes.to_vec());
    }

    /// Sets a track's first segment start, its stored type and its container
    /// init bytes, and clears its segments. Setting the video track gives the
    /// song a video.
    #[wasm_bindgen(js_name = setTrack)]
    pub fn set_track(&mut self, kind: TrackKind, start_ms: u32, stored_type: String, init: &[u8]) {
        *self.track(kind) = TrackPlan {
            start_ms,
            stored_type,
            init: init.to_vec(),
            segments: Vec::new(),
        };
    }

    /// Plans a media segment at the end of a track by its duration and its
    /// byte length. The bytes come later, through [`SongWriter::segment`].
    #[wasm_bindgen(js_name = addSegment)]
    pub fn add_segment(&mut self, kind: TrackKind, duration_ms: u32, length: u32) {
        self.track(kind).segments.push(SegmentPlan {
            duration_ms,
            length,
        });
    }

    /// Checks the whole song, then gives the header and the index: the first
    /// piece of the file. Names the part the core refused, before any piece is
    /// given. Calling it again gives `Media`.
    pub fn start(&mut self) -> Result<Vec<u8>, SongWriteFault> {
        if self.writer.is_some() {
            return Err(SongWriteErrorKind::Media.into());
        }
        let song_id: [u8; 16] = self
            .song_id
            .as_slice()
            .try_into()
            .map_err(|_| SongWriteErrorKind::Media)?;
        let details = SongDetails::new(
            self.title.clone(),
            self.artist.clone(),
            self.composer.clone(),
            self.vocal_role.into(),
        )
        .map_err(|_| SongWriteErrorKind::Details)?;
        let lyrics = Lyrics::parse(&self.lyrics).map_err(|_| SongWriteErrorKind::Lyrics)?;
        let (pairs, rest) = self.times_ms.as_chunks::<2>();
        if !rest.is_empty() {
            return Err(SongWriteErrorKind::Times.into());
        }
        let syllables = pairs
            .iter()
            .map(|&[start_ms, end_ms]| SyllableTime { start_ms, end_ms })
            .collect();
        let timing = Timing::new(syllables).map_err(|_| SongWriteErrorKind::Times)?;
        let plan = SongPlan {
            song_id,
            details,
            thumbnail: self.thumbnail.clone(),
            lyrics,
            timing,
            video: self.video.clone(),
            karaoke: self.karaoke.clone(),
            original: self.original.clone(),
        };
        let writer = PieceWriter::new(plan)?;
        let head = writer.head().to_vec();
        self.writer = Some(writer);
        Ok(head)
    }

    /// Says what the next chunk is. Calling it again before that chunk is
    /// taken gives the same answer. A call before `start` gives `Media`.
    #[wasm_bindgen(js_name = nextChunk)]
    pub fn next_chunk(&mut self) -> Result<NextChunk, SongWriteFault> {
        let writer = self.writer.as_mut().ok_or(SongWriteErrorKind::Media)?;
        if self.pending.is_some() {
            return Ok(NextChunk::Core);
        }
        Ok(match writer.next_chunk() {
            Next::Chunk(bytes) => {
                self.pending = Some(bytes);
                NextChunk::Core
            }
            Next::Segment(ChunkType::VideoSegment) => NextChunk::VideoSegment,
            Next::Segment(ChunkType::KaraokeSegment) => NextChunk::KaraokeSegment,
            Next::Segment(_) => NextChunk::OriginalSegment,
            Next::End => NextChunk::End,
        })
    }

    /// Takes the bytes of the chunk that `nextChunk` said the core made.
    #[wasm_bindgen(js_name = coreChunk)]
    pub fn core_chunk(&mut self) -> Result<Vec<u8>, SongWriteFault> {
        self.pending
            .take()
            .ok_or_else(|| SongWriteErrorKind::Media.into())
    }

    /// Takes the bytes of the media segment that `nextChunk` named, checks
    /// their length against the plan and hands them back to write. The bytes
    /// are taken by value, so only one copy sits in memory.
    pub fn segment(&mut self, bytes: Vec<u8>) -> Result<Vec<u8>, SongWriteFault> {
        let writer = self.writer.as_mut().ok_or(SongWriteErrorKind::Media)?;
        if self.pending.is_some() {
            return Err(SongWriteErrorKind::Media.into());
        }
        Ok(writer.segment(bytes)?)
    }
}

impl SongWriter {
    fn track(&mut self, kind: TrackKind) -> &mut TrackPlan {
        match kind {
            TrackKind::Video => self.video.get_or_insert_with(TrackPlan::default),
            TrackKind::Karaoke => &mut self.karaoke,
            TrackKind::Original => &mut self.original,
        }
    }
}

/// The checked index of a version-0 or a version-1 song file.
enum OpenIndex {
    V0(Index),
    V1(v1::Index),
}

impl OpenIndex {
    fn entries(&self) -> &[IndexEntry] {
        match self {
            OpenIndex::V0(index) => index.entries(),
            OpenIndex::V1(index) => index.entries(),
        }
    }

    fn duration_ms(&self) -> u32 {
        match self {
            OpenIndex::V0(index) => index.duration_ms(),
            OpenIndex::V1(index) => index.duration_ms(),
        }
    }

    fn read_chunk(&self, position: usize, bytes: &[u8]) -> Result<Chunk, SongFileError> {
        match self {
            OpenIndex::V0(index) => {
                let entry = index
                    .entries()
                    .get(position)
                    .ok_or(SongFileError::NoEntry { position })?;
                song_file::read_chunk(entry, bytes)
            }
            OpenIndex::V1(index) => index.read_chunk(position, bytes),
        }
    }
}

/// Reads a song file the way the format's reading model says: the header,
/// then the index with the file size, then one chunk at a time. The client
/// passes the bytes. The reader never needs the whole file.
#[wasm_bindgen]
pub struct SongReader {
    song_id: [u8; 16],
    index: OpenIndex,
    entries: Vec<ChunkEntry>,
    details: Option<SongDetails>,
    lyrics: Option<Lyrics>,
    timing: Option<Timing>,
    /// The stored type of each init segment chunk read so far, by position.
    stored_types: Vec<Option<String>>,
    /// The display lines of the latest layout. Empty if there is none, or
    /// the core refused it.
    display_lines: Vec<DisplayLine>,
}

#[wasm_bindgen]
impl SongReader {
    /// The length of the header at the start of `start`: 32 bytes in version
    /// 0 and 177 in version 1. Needs the first 10 bytes.
    #[wasm_bindgen(js_name = headerLength)]
    pub fn header_length(start: &[u8]) -> Result<u32, SongFileFault> {
        let len = match header_version(start)? {
            0 => song_file::HEADER_LEN,
            1 => v1::HEADER_LEN,
            _ => return Err(DAMAGED),
        };
        Ok(len as u32)
    }

    /// The length of the index that follows the `header`. In version 1 it
    /// includes the 16-byte tag after the index.
    #[wasm_bindgen(js_name = indexLength)]
    pub fn index_length(header: &[u8]) -> Result<u32, SongFileFault> {
        // A version-1 header needs its 177 bytes. With only the 32 bytes of a
        // version-0 header, the version-0 check gives its usual refusal.
        let len = if header_version(header)? == 1 && header.len() >= v1::HEADER_LEN {
            v1::Header::parse(header)?.index_len() + v1::TAG_LEN
        } else {
            Header::parse(header)?.index_len()
        };
        u32::try_from(len).map_err(|_| DAMAGED)
    }

    /// Checks the `header` and the `index` against the total `file_size`.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8], index: &[u8], file_size: f64) -> Result<SongReader, SongFileFault> {
        let header = Header::parse(header)?;
        // A size that is negative, fractional or too large becomes one the
        // index check rejects or compares exactly.
        let index = Index::parse(&header, index, file_size as u64)?;
        SongReader::with_index(header.song_id(), OpenIndex::V0(index))
    }

    /// Opens a version-1 song file: checks the `header`, opens the
    /// `access_file` with this device's key, then checks the index and its
    /// tag (`index_and_tag`) against the total `file_size`. The content key
    /// stays in the core. A version-0 file is refused as an old version.
    #[wasm_bindgen(js_name = openEncrypted)]
    pub fn open_encrypted(
        header: &[u8],
        index_and_tag: &[u8],
        file_size: f64,
        device_key: &DeviceKey,
        access_file: &[u8],
    ) -> Result<SongReader, SongFileFault> {
        match header_version(header)? {
            0 => return Err(SongFileFaultKind::OldVersion.into()),
            1 => {}
            _ => return Err(DAMAGED),
        }
        let header = v1::Header::parse(header)?;
        let access = access::open(access_file, &device_key.key, &header.song_id())?;
        // `access` drops at the end, which wipes the content key.
        let index = v1::Index::open(
            &header,
            &access.content_key,
            index_and_tag,
            file_size as u64,
        )?;
        SongReader::with_index(header.song_id(), OpenIndex::V1(index))
    }

    fn with_index(song_id: [u8; 16], index: OpenIndex) -> Result<SongReader, SongFileFault> {
        let entries = index
            .entries()
            .iter()
            .map(ChunkEntry::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SongReader {
            song_id,
            index,
            stored_types: vec![None; entries.len()],
            entries,
            details: None,
            lyrics: None,
            timing: None,
            display_lines: Vec::new(),
        })
    }

    /// The song's duration: the karaoke track's end, its last segment's
    /// start plus its duration.
    #[wasm_bindgen(getter, js_name = durationMs)]
    pub fn duration_ms(&self) -> u32 {
        self.index.duration_ms()
    }

    /// The song ID from the header, as 32 lowercase hex digits.
    #[wasm_bindgen(getter, js_name = songId)]
    pub fn song_id(&self) -> String {
        self.song_id
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// The song details, once their chunk is read.
    pub fn details(&self) -> Option<Details> {
        self.details.as_ref().map(Details::from)
    }

    /// The index entries, in the order the chunks are stored.
    pub fn entries(&self) -> Vec<ChunkEntry> {
        self.entries.clone()
    }

    /// Every syllable of the lyrics, in lyric order, with its timing. It is
    /// empty until the lyrics and the timing are both read.
    pub fn syllables(&self) -> Vec<LyricSyllable> {
        let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) else {
            return Vec::new();
        };
        let text = lyrics.as_str();
        let mut times = timing.syllables().iter();
        let mut syllables = Vec::new();
        for (index, line) in lyrics.lines().iter().enumerate() {
            let mut previous_end = None;
            for syllable in line.syllables() {
                let Some(time) = times.next() else {
                    return syllables;
                };
                let range = syllable.range();
                let separator = previous_end.map_or("", |end| &text[end..range.start]);
                previous_end = Some(range.end);
                syllables.push(LyricSyllable {
                    text: text[range].to_owned(),
                    separator: separator.to_owned(),
                    // At most 65,536 syllables, so every index fits.
                    lyric_line: index as u32,
                    start_ms: time.start_ms,
                    end_ms: time.end_ms,
                });
            }
        }
        syllables
    }

    /// Lays out the lyrics as display lines that fit `max_width`. `widths`
    /// holds the measured width of every syllable, in lyric order, and
    /// `space_width` the width of the space between two syllables.
    ///
    /// It returns no display lines while the lyrics or the timing are not
    /// read, and when the core refuses the layout: a width count that does
    /// not match the syllables, or a width that is negative or not finite.
    /// The layout is kept for [`SongReader::lyrics_rows`].
    #[wasm_bindgen(js_name = layOut)]
    pub fn lay_out(
        &mut self,
        widths: &[f64],
        space_width: f64,
        max_width: f64,
    ) -> Vec<DisplayLineSpan> {
        self.display_lines.clear();
        let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) else {
            return Vec::new();
        };
        if widths.len() != timing.syllables().len() {
            return Vec::new();
        }
        let measured: Vec<MeasuredSyllable> = widths
            .iter()
            .zip(timing.syllables())
            .map(|(&width, time)| MeasuredSyllable {
                width,
                start_ms: time.start_ms,
                end_ms: time.end_ms,
            })
            .collect();
        let Ok(display_lines) = display_lines::lay_out(lyrics, &measured, space_width, max_width)
        else {
            return Vec::new();
        };
        self.display_lines = display_lines;
        // The index of each lyric line's first syllable.
        let mut first = Vec::with_capacity(lyrics.lines().len());
        let mut count = 0;
        for line in lyrics.lines() {
            first.push(count);
            count += line.syllables().len();
        }
        self.display_lines
            .iter()
            .map(|line| {
                let offset = first[line.lyric_line];
                // At most 65,536 syllables, so every index fits.
                DisplayLineSpan {
                    lyric_line: line.lyric_line as u32,
                    start: (offset + line.syllables.start) as u32,
                    end: (offset + line.syllables.end) as u32,
                }
            })
            .collect()
    }

    /// How far the highlight has swept at media time `ms`: the syllables
    /// already sung, plus the fraction of the one being sung. It is 0 while
    /// the timing is not read.
    #[wasm_bindgen(js_name = sweepPosition)]
    pub fn sweep_position(&self, ms: f64) -> f64 {
        self.timing.as_ref().map_or(0.0, |timing| {
            highlight::sweep_position(timing.syllables(), ms)
        })
    }

    /// The lyric lines that have countdown dots, in order. It is empty while
    /// the lyrics and the timing are not both read.
    #[wasm_bindgen(js_name = countdownLines)]
    pub fn countdown_lines(&self) -> Vec<u32> {
        let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) else {
            return Vec::new();
        };
        countdown::countdowns(lyrics, timing.syllables())
            .iter()
            // At most 65,536 syllables, so every index fits.
            .map(|countdown| countdown.lyric_line as u32)
            .collect()
    }

    /// The total number of countdown dots swept at media time `ms`, across
    /// every countdown, with the fraction of the dot being swept. Countdown
    /// `k`, counting from 0, shows `clamp(total - 4k, 0, 4)` dots swept. It is
    /// 0 while the lyrics and the timing are not both read.
    #[wasm_bindgen(js_name = dotsSwept)]
    pub fn dots_swept(&self, ms: f64) -> f64 {
        let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) else {
            return 0.0;
        };
        countdown::dots_swept(&countdown::countdowns(lyrics, timing.syllables()), ms)
    }

    /// The display lines the top and the bottom row of the Lyrics area show
    /// at media time `ms`, for the latest layout. Both rows are empty while
    /// the lyrics and the timing are not both read, and when there is no
    /// layout.
    #[wasm_bindgen(js_name = lyricsRows)]
    pub fn lyrics_rows(&self, ms: f64) -> LyricsRows {
        let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) else {
            return LyricsRows {
                top: None,
                bottom: None,
            };
        };
        let countdowns = countdown::countdowns(lyrics, timing.syllables());
        let rows = lyrics_rows::rows(
            lyrics,
            timing.syllables(),
            &countdowns,
            &self.display_lines,
            ms,
        );
        // At most 65,536 display lines, so every index fits.
        LyricsRows {
            top: rows.top.map(|row| row as u32),
            bottom: rows.bottom.map(|row| row as u32),
        }
    }

    /// The stored type of the init segment chunk at `position`, once that
    /// chunk is read.
    #[wasm_bindgen(js_name = storedType)]
    pub fn stored_type(&self, position: u32) -> Option<String> {
        let position = usize::try_from(position).ok()?;
        self.stored_types.get(position)?.clone()
    }

    /// Checks the `bytes` of the chunk at `position` in the index. Returns
    /// the bytes of a media segment, or an init segment's container init
    /// bytes, and nothing for any other chunk. An init segment's stored type
    /// is kept for `storedType`. Once the lyrics and the timing are both
    /// read, it checks one against the other.
    #[wasm_bindgen(js_name = readChunk)]
    pub fn read_chunk(
        &mut self,
        position: u32,
        bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, SongFileFault> {
        let position = usize::try_from(position).map_err(|_| DAMAGED)?;
        if position >= self.entries.len() {
            return Err(DAMAGED);
        }
        match self.index.read_chunk(position, bytes)? {
            Chunk::Init { stored_type, init } => {
                self.stored_types[position] = Some(stored_type);
                return Ok(Some(init));
            }
            Chunk::Media(bytes) => return Ok(Some(bytes)),
            Chunk::Lyrics(lyrics) => self.lyrics = Some(lyrics),
            Chunk::Timing(timing) => self.timing = Some(timing),
            Chunk::SongDetails(details) => self.details = Some(details),
            Chunk::Thumbnail(_) => {}
        }
        if let (Some(lyrics), Some(timing)) = (&self.lyrics, &self.timing) {
            song_file::check_timing(timing, lyrics, self.index.duration_ms())?;
        }
        Ok(None)
    }
}

/// A pinned model file: the ID that names it, where it is downloaded from
/// and its size in bytes. A test entry's URL is relative to the site.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq)]
pub struct PinnedModelFile {
    #[wasm_bindgen(getter_with_clone)]
    pub id: String,
    #[wasm_bindgen(getter_with_clone)]
    pub url: String,
    pub size: f64,
}

/// Every pinned model file, in the core's order.
#[wasm_bindgen(js_name = pinnedFiles)]
pub fn pinned_files() -> Vec<PinnedModelFile> {
    model::PINNED_FILES
        .iter()
        .map(|file| PinnedModelFile {
            id: file.id.to_owned(),
            url: file.url.to_owned(),
            // Every pinned size is far below 2^53, so it is exact as a number.
            size: file.size as f64,
        })
        .collect()
}

/// The result of a model check: the file's ID and whether it passed. It
/// holds no file bytes.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCheckResult {
    #[wasm_bindgen(getter_with_clone)]
    pub id: String,
    pub passed: bool,
}

/// Checks a downloaded model file against its pinned size and SHA-256. The
/// client feeds the download in pieces. The check keeps only the hash
/// state, never the bytes.
#[wasm_bindgen]
pub struct ModelCheck {
    check: model::ModelCheck,
}

#[wasm_bindgen]
impl ModelCheck {
    /// Starts a check of the pinned model file with this `id`. There is
    /// none for an unknown ID.
    pub fn start(id: &str) -> Option<ModelCheck> {
        model::ModelCheck::new(id).map(|check| ModelCheck { check })
    }

    /// Hashes the next `piece` of the download. Returns false once the file
    /// has grown past its pinned size, and the client should stop. Every
    /// later piece is then ignored.
    pub fn feed(&mut self, piece: &[u8]) -> bool {
        self.check.feed(piece)
    }

    /// The result so far. It passes only when exactly the pinned size was
    /// fed and the SHA-256 matches.
    pub fn result(&self) -> ModelCheckResult {
        let result = self.check.result();
        ModelCheckResult {
            id: result.id.to_owned(),
            passed: result.passed,
        }
    }
}

/// Why a separation step failed.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeparationFaultKind {
    /// The step was refused, for example empty audio, a segment out of range
    /// or an output of the wrong length.
    Refused = 0,
    /// The broken-run check failed its not-finite rule: a vocals sample is
    /// NaN or infinite.
    VocalsNotFinite = 1,
    /// The broken-run check failed its not-finite rule: a karaoke track
    /// sample is NaN or infinite.
    KaraokeNotFinite = 2,
    /// The broken-run check failed its peak rule: the vocals peak too high.
    VocalsPeak = 3,
}

/// Why a separation step failed. It holds no core message, because those are
/// not meant for users.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeparationFault {
    kind: SeparationFaultKind,
    measured_db: Option<f64>,
    sample: Option<u32>,
}

#[wasm_bindgen]
impl SeparationFault {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> SeparationFaultKind {
        self.kind
    }

    /// The peak the failed peak rule measured, in dB above the source.
    /// Set only for the peak kind.
    #[wasm_bindgen(getter, js_name = measuredDb)]
    pub fn measured_db(&self) -> Option<f64> {
        self.measured_db
    }

    /// The position of the first sample that is not finite, counting from 0
    /// in the planar track. Set only for the not-finite kinds.
    #[wasm_bindgen(getter)]
    pub fn sample(&self) -> Option<u32> {
        self.sample
    }
}

/// The fault for a refusal with no value to name.
const REFUSED: SeparationFault = SeparationFault {
    kind: SeparationFaultKind::Refused,
    measured_db: None,
    sample: None,
};

impl From<SeparationError> for SeparationFault {
    fn from(error: SeparationError) -> SeparationFault {
        let position = |at: usize| Some(u32::try_from(at).unwrap_or(u32::MAX));
        match error {
            SeparationError::BrokenRun(BrokenRun::VocalsNotFinite { at }) => SeparationFault {
                kind: SeparationFaultKind::VocalsNotFinite,
                measured_db: None,
                sample: position(at),
            },
            SeparationError::BrokenRun(BrokenRun::KaraokeNotFinite { at }) => SeparationFault {
                kind: SeparationFaultKind::KaraokeNotFinite,
                measured_db: None,
                sample: position(at),
            },
            SeparationError::BrokenRun(BrokenRun::VocalsPeak { db }) => SeparationFault {
                kind: SeparationFaultKind::VocalsPeak,
                measured_db: Some(db),
                sample: None,
            },
            _ => REFUSED,
        }
    }
}

/// The vocals and the karaoke track of a song, with the peaks the broken-run
/// check measured. Both tracks are planar stereo: the left channel, then the
/// right, `2 * samples` values.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq)]
pub struct SeparatedTracks {
    #[wasm_bindgen(getter_with_clone)]
    pub vocals: Vec<f32>,
    #[wasm_bindgen(getter_with_clone)]
    pub karaoke: Vec<f32>,
    #[wasm_bindgen(js_name = vocalsPeakDb)]
    pub vocals_peak_db: f64,
    #[wasm_bindgen(js_name = karaokePeakDb)]
    pub karaoke_peak_db: f64,
}

/// The separation of a whole song. The client gives the audio, then runs the
/// model on each segment's input and gives back its output, and finally
/// takes the tracks.
#[wasm_bindgen]
pub struct Separation {
    /// Gone once `finish` has taken it.
    separation: Option<mel_roformer::Separation>,
}

#[wasm_bindgen]
impl Separation {
    /// Starts a separation of 44.1 kHz stereo audio, given as the left and
    /// the right channel.
    #[wasm_bindgen(constructor)]
    pub fn new(left: &[f32], right: &[f32]) -> Result<Separation, SeparationFault> {
        Ok(Separation {
            separation: Some(mel_roformer::Separation::new(left, right)?),
        })
    }

    /// The number of segments, or 0 once finished.
    #[wasm_bindgen(getter, js_name = segmentCount)]
    pub fn segment_count(&self) -> u32 {
        self.separation
            .as_ref()
            // A segment takes over 350,000 samples, so the count fits.
            .map_or(0, |s| u32::try_from(s.segment_count()).unwrap_or(u32::MAX))
    }

    /// The model's input for the segment `index`: the spectrogram of
    /// `SPEC_LEN` values.
    pub fn input(&mut self, index: u32) -> Result<Vec<f32>, SeparationFault> {
        Ok(self.active()?.input(index as usize)?)
    }

    /// Takes the model's output for the segment `index`: the vocals'
    /// spectrogram of `SPEC_LEN` values.
    pub fn output(&mut self, index: u32, spec_out: &[f32]) -> Result<(), SeparationFault> {
        Ok(self.active()?.output(index as usize, spec_out)?)
    }

    /// Joins the segments and applies the broken-run check. This ends the
    /// separation, also when the check fails.
    pub fn finish(&mut self) -> Result<SeparatedTracks, SeparationFault> {
        let separation = self.separation.take().ok_or(REFUSED)?;
        let tracks = separation.finish()?;
        Ok(SeparatedTracks {
            vocals: tracks.vocals,
            karaoke: tracks.karaoke,
            vocals_peak_db: tracks.check.vocals_peak_db,
            karaoke_peak_db: tracks.check.karaoke_peak_db,
        })
    }
}

impl Separation {
    fn active(&mut self) -> Result<&mut mel_roformer::Separation, SeparationFault> {
        self.separation.as_mut().ok_or(REFUSED)
    }
}

/// Why a web device key could not be derived.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyFaultKind {
    /// The PRF output is not 32 bytes.
    PrfLength,
    /// The derived private scalar is zero.
    ZeroScalar,
}

/// Why a web device key could not be derived. It holds no core message.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceKeyFault {
    kind: DeviceKeyFaultKind,
}

#[wasm_bindgen]
impl DeviceKeyFault {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> DeviceKeyFaultKind {
        self.kind
    }
}

impl From<DeviceKeyError> for DeviceKeyFault {
    fn from(error: DeviceKeyError) -> DeviceKeyFault {
        let kind = match error {
            DeviceKeyError::PrfLength => DeviceKeyFaultKind::PrfLength,
            DeviceKeyError::ZeroScalar => DeviceKeyFaultKind::ZeroScalar,
        };
        DeviceKeyFault { kind }
    }
}

/// The QR code of a device code: the modules of a square symbol, without the
/// quiet zone.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCodeQr {
    /// The side of the symbol, in modules.
    pub size: u32,
    /// The modules row by row from the top left: 1 for dark, 0 for light.
    #[wasm_bindgen(getter_with_clone)]
    pub modules: Vec<u8>,
}

/// The fixed Lyre PRF salt, as UTF-8 bytes. The client passes it as the
/// WebAuthn PRF `eval.first` input.
#[wasm_bindgen(js_name = devicePrfSalt)]
pub fn device_prf_salt() -> Vec<u8> {
    device::PRF_SALT.as_bytes().to_vec()
}

/// This web device's key, as an opaque handle. It shows only the device code
/// the fingerprint and the QR code. The private key stays in the core and
/// cannot be read.
#[wasm_bindgen]
pub struct DeviceKey {
    key: device::DeviceKey,
    device_code: String,
    fingerprint: String,
    qr_code: DeviceCodeQr,
}

#[wasm_bindgen]
impl DeviceKey {
    /// Derives the key from the passkey's PRF output, then overwrites
    /// `prf_output` with zeros, whether or not the derivation worked.
    #[wasm_bindgen(constructor)]
    pub fn new(prf_output: &mut [u8]) -> Result<DeviceKey, DeviceKeyFault> {
        let key = device::DeviceKey::from_prf_output(prf_output);
        prf_output.zeroize();
        let key = key?;
        let public_key = key.public_key();
        let qr = public_key.qr_code();
        Ok(DeviceKey {
            device_code: public_key.device_code(),
            fingerprint: public_key.fingerprint(),
            qr_code: DeviceCodeQr {
                size: qr.size as u32,
                modules: qr.dark.iter().map(|&dark| u8::from(dark)).collect(),
            },
            key,
        })
    }

    /// The device code, 65 lowercase characters.
    #[wasm_bindgen(getter, js_name = deviceCode)]
    pub fn device_code(&self) -> String {
        self.device_code.clone()
    }

    /// The fingerprint, 20 digits in five groups of four.
    #[wasm_bindgen(getter)]
    pub fn fingerprint(&self) -> String {
        self.fingerprint.clone()
    }

    /// The QR code of the device code.
    #[wasm_bindgen(getter, js_name = qrCode)]
    pub fn qr_code(&self) -> DeviceCodeQr {
        self.qr_code.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use lyre_core::content_key::ContentKey;
    use lyre_core::recovery::RecoveryKey;

    use super::*;

    const FORMAT_DOC: &str = include_str!("../../../docs/reference/song-file-format-v0.md");

    /// The known-answer example, read from the format doc's hex dump.
    fn example() -> Vec<u8> {
        let (_, after) = FORMAT_DOC
            .split_once("### Hex dump")
            .expect("the format doc has a hex dump");
        let (_, block) = after
            .split_once("```text\n")
            .expect("the hex dump is a text block");
        let (dump, _) = block.split_once("```").expect("the text block ends");
        let mut bytes = Vec::new();
        for line in dump.lines() {
            let (_, rest) = line.split_once(": ").expect("an xxd line");
            let (hex, _) = rest.split_once("  ").expect("hex, then text");
            for group in hex.split_whitespace() {
                for pair in group.as_bytes().chunks(2) {
                    let pair = std::str::from_utf8(pair).expect("ASCII hex");
                    bytes.push(u8::from_str_radix(pair, 16).expect("a hex byte"));
                }
            }
        }
        assert_eq!(bytes.len(), 307);
        bytes
    }

    /// Reads `file` as a client does: the header, the index, then each chunk
    /// on its own. Returns the media chunks' bytes.
    fn read(file: &[u8]) -> Result<Vec<Vec<u8>>, SongFileFault> {
        read_all(file).map(|(_, media)| media)
    }

    /// Reads `file` as `read` does. Returns the reader, then the media
    /// chunks' bytes.
    fn read_all(file: &[u8]) -> Result<(SongReader, Vec<Vec<u8>>), SongFileFault> {
        let header = file.get(..32).unwrap_or(file);
        let index_end = 32 + SongReader::index_length(header)? as usize;
        let index = file.get(32..index_end).ok_or(DAMAGED)?;
        let mut reader = SongReader::new(header, index, file.len() as f64)?;
        let mut media = Vec::new();
        for (position, entry) in reader.entries().into_iter().enumerate() {
            let start = entry.offset as usize;
            let bytes = file
                .get(start..start + entry.length as usize)
                .ok_or(DAMAGED)?;
            if let Some(bytes) = reader.read_chunk(position as u32, bytes)? {
                media.push(bytes);
            }
        }
        Ok((reader, media))
    }

    /// Reads the version-1 `file` as a client does, with this device's key
    /// and an access file. Returns the reader, then the media chunks' bytes.
    fn read_encrypted(
        file: &[u8],
        device: &DeviceKey,
        access_file: &[u8],
    ) -> Result<(SongReader, Vec<Vec<u8>>), SongFileFault> {
        let header_end = SongReader::header_length(file)? as usize;
        let header = file.get(..header_end).ok_or(DAMAGED)?;
        let index_end = header_end + SongReader::index_length(header)? as usize;
        let index = file.get(header_end..index_end).ok_or(DAMAGED)?;
        let mut reader =
            SongReader::open_encrypted(header, index, file.len() as f64, device, access_file)?;
        let mut media = Vec::new();
        for (position, entry) in reader.entries().into_iter().enumerate() {
            let start = entry.offset as usize;
            let bytes = file
                .get(start..start + entry.length as usize)
                .ok_or(DAMAGED)?;
            if let Some(bytes) = reader.read_chunk(position as u32, bytes)? {
                media.push(bytes);
            }
        }
        Ok((reader, media))
    }

    const PRF: [u8; 32] = [7; 32];

    /// The device key as the core and as the wasm handle.
    fn device_keys(prf: u8) -> (device::DeviceKey, DeviceKey) {
        let core = device::DeviceKey::from_prf_output(&[prf; 32]).expect("a valid PRF output");
        let handle = DeviceKey::new(&mut [prf; 32]).expect("a valid PRF output");
        (core, handle)
    }

    fn fixture_manifest() -> &'static Path {
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/song/song.toml"
        ))
    }

    fn kind_of<T>(result: Result<T, SongFileFault>) -> SongFileFaultKind {
        match result {
            Ok(_) => panic!("the file should be refused"),
            Err(fault) => fault.kind(),
        }
    }

    /// The 56-byte two-block test vector of FIPS 180-2.
    const TWO_BLOCK: &[u8] = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";

    #[test]
    fn a_source_track_gets_its_stored_type() {
        assert_eq!(
            stored_type("vp9", "vp09.00.10.08").as_deref(),
            Some("video/webm; codecs=\"vp09.00.10.08\"")
        );
        assert_eq!(stored_type("flac", "flac"), None);
    }

    #[test]
    fn a_model_check_passes_for_the_pinned_bytes() {
        let mut check = ModelCheck::start("test-two-block").expect("a pinned ID");
        assert!(check.feed(&TWO_BLOCK[..10]));
        assert!(check.feed(&TWO_BLOCK[10..]));
        assert_eq!(
            check.result(),
            ModelCheckResult {
                id: "test-two-block".to_owned(),
                passed: true,
            }
        );
    }

    #[test]
    fn a_model_check_fails_with_one_byte_changed() {
        let mut changed = TWO_BLOCK.to_vec();
        changed[20] ^= 0x01;
        let mut check = ModelCheck::start("test-two-block").expect("a pinned ID");
        assert!(check.feed(&changed));
        assert!(!check.result().passed);
    }

    #[test]
    fn lists_every_pinned_file() {
        let files = pinned_files();
        assert_eq!(files.len(), 9);
        assert!(files.contains(&PinnedModelFile {
            id: "test-two-block".to_owned(),
            url: "test-models/two-block.bin".to_owned(),
            size: 56.0,
        }));
    }

    #[test]
    fn an_unknown_model_gives_no_check() {
        assert!(ModelCheck::start("no-such-model").is_none());
    }

    #[test]
    fn a_broken_run_names_its_rule_and_value() {
        for (failure, kind, measured_db, sample) in [
            (
                BrokenRun::VocalsNotFinite { at: 7 },
                SeparationFaultKind::VocalsNotFinite,
                None,
                Some(7),
            ),
            (
                BrokenRun::KaraokeNotFinite { at: 9 },
                SeparationFaultKind::KaraokeNotFinite,
                None,
                Some(9),
            ),
            (
                BrokenRun::VocalsPeak { db: 9.9 },
                SeparationFaultKind::VocalsPeak,
                Some(9.9),
                None,
            ),
        ] {
            let fault = SeparationFault::from(SeparationError::BrokenRun(failure));
            assert_eq!(fault.kind(), kind);
            assert_eq!(fault.measured_db(), measured_db);
            assert_eq!(fault.sample(), sample);
        }
    }

    #[test]
    fn a_refused_separation_step_has_no_measurement() {
        let fault = SeparationFault::from(SeparationError::NoAudio);
        assert_eq!(fault.kind(), SeparationFaultKind::Refused);
        assert_eq!(fault.measured_db(), None);
        assert_eq!(fault.sample(), None);
        assert_eq!(
            Separation::new(&[0.0; 2], &[0.0; 3])
                .err()
                .map(|f| f.kind()),
            Some(SeparationFaultKind::Refused)
        );
    }

    #[test]
    fn a_finished_separation_refuses_more_steps() {
        let mut separation = Separation::new(&[0.0; 4], &[0.0; 4]).expect("audio");
        assert_eq!(separation.segment_count(), 1);
        assert!(separation.finish().is_err());
        assert_eq!(separation.segment_count(), 0);
        assert_eq!(
            separation.input(0).err().map(|f| f.kind()),
            Some(SeparationFaultKind::Refused)
        );
        assert_eq!(
            separation.finish().err().map(|f| f.kind()),
            Some(SeparationFaultKind::Refused)
        );
    }

    #[test]
    fn a_separation_gives_the_spectrogram_of_a_segment() {
        let mut separation = Separation::new(&[0.5; 4], &[0.5; 4]).expect("audio");
        let spec = separation.input(0).expect("segment 0 exists");
        assert_eq!(spec.len(), mel_roformer::SPEC_LEN);
    }

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }

    #[test]
    fn reads_the_known_answer_example() {
        let file = example();
        let header = &file[..32];
        assert_eq!(SongReader::index_length(header), Ok(7 * 24));
        let reader = SongReader::new(header, &file[32..200], 307.0).expect("the example is valid");
        assert_eq!(reader.duration_ms(), 1_000);
        let entries = reader.entries();
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries[4],
            ChunkEntry {
                kind: ChunkKind::KaraokeSegment,
                offset: 270,
                length: 2,
                start_ms: 0,
                duration_ms: 1_000,
            }
        );
        assert_eq!(
            read(&file),
            Ok(vec![
                b"ki".to_vec(),
                b"ks".to_vec(),
                b"oi".to_vec(),
                b"os".to_vec()
            ])
        );
    }

    #[test]
    fn gives_the_stored_type_of_each_init_chunk_once_read() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 307.0).expect("valid");
        assert_eq!(reader.stored_type(3), None);
        assert_eq!(
            reader.read_chunk(3, &file[241..270]),
            Ok(Some(b"ki".to_vec()))
        );
        assert_eq!(
            reader.stored_type(3),
            Some("audio/webm; codecs=\"opus\"".to_owned())
        );
        assert_eq!(reader.stored_type(5), None);

        let (reader, _) = read_all(&file).expect("the example is valid");
        assert_eq!(
            reader.stored_type(5),
            Some("audio/mp4; codecs=\"mp4a.40.2\"".to_owned())
        );
        // Chunks that are not init segments, and positions outside the
        // index, have no stored type.
        assert_eq!(reader.stored_type(4), None);
        assert_eq!(reader.stored_type(7), None);
    }

    #[test]
    fn a_wrong_karaoke_type_is_damaged() {
        let mut file = example();
        file[243] = b'A';
        let fault = read(&file).expect_err("the karaoke type is wrong");
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn reads_the_known_answer_example_song_id_and_details() {
        let (reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(reader.song_id(), "000102030405060708090a0b0c0d0e0f");
        assert_eq!(
            reader.details(),
            Some(Details {
                title: "Mưa".to_owned(),
                artist: String::new(),
                composer: String::new(),
                vocal_role: Role::Female,
            })
        );
    }

    #[test]
    fn has_no_details_before_their_chunk_is_read() {
        let file = example();
        let reader = SongReader::new(&file[..32], &file[32..200], 307.0).expect("valid");
        assert_eq!(reader.details(), None);
    }

    #[test]
    fn gives_the_known_answer_example_syllables_with_their_separators() {
        let (reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(
            reader.syllables(),
            vec![
                LyricSyllable {
                    text: "Mưa".to_owned(),
                    separator: String::new(),
                    lyric_line: 0,
                    start_ms: 0,
                    end_ms: 500,
                },
                LyricSyllable {
                    text: "rơi".to_owned(),
                    separator: " ".to_owned(),
                    lyric_line: 0,
                    start_ms: 500,
                    end_ms: 1_000,
                },
            ]
        );
    }

    #[test]
    fn lays_out_the_known_answer_example() {
        let (mut reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(
            reader.lay_out(&[10.0, 10.0], 2.0, 100.0),
            vec![DisplayLineSpan {
                lyric_line: 0,
                start: 0,
                end: 2,
            }]
        );
    }

    #[test]
    fn a_layout_the_core_refuses_has_no_display_lines() {
        let (mut reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(reader.lay_out(&[10.0], 2.0, 100.0), vec![]);
        assert_eq!(reader.lay_out(&[10.0, 10.0, 10.0], 2.0, 100.0), vec![]);
        assert_eq!(reader.lay_out(&[10.0, -1.0], 2.0, 100.0), vec![]);
    }

    #[test]
    fn sweeps_the_known_answer_example() {
        let (reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(reader.sweep_position(0.0), 0.0);
        assert_eq!(reader.sweep_position(250.0), 0.5);
        assert_eq!(reader.sweep_position(1_000.0), 2.0);
    }

    #[test]
    fn counts_down_to_the_first_line_of_the_known_answer_example() {
        let (reader, _) = read_all(&example()).expect("the example is valid");
        assert_eq!(reader.countdown_lines(), vec![0]);
        assert_eq!(reader.dots_swept(0.0), 4.0);
    }

    #[test]
    fn has_no_syllables_layout_sweep_or_countdown_before_the_lyrics_and_timing_are_read() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 307.0).expect("valid");
        assert_eq!(reader.syllables(), vec![]);
        assert_eq!(reader.lay_out(&[10.0, 10.0], 2.0, 100.0), vec![]);
        assert_eq!(reader.sweep_position(250.0), 0.0);
        assert_eq!(reader.countdown_lines(), Vec::<u32>::new());
        assert_eq!(reader.dots_swept(1_000.0), 0.0);
        assert_eq!(
            reader.lyrics_rows(1_000.0),
            LyricsRows {
                top: None,
                bottom: None
            }
        );
    }

    #[test]
    fn gives_the_rows_of_the_fixture_song_for_the_latest_layout() {
        let manifest = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/song/song.toml"
        ));
        let file = lyre_cli::build(manifest).expect("the fixture song builds");
        let (mut reader, _) = read_all(&file).expect("the fixture song is valid");
        let none = LyricsRows {
            top: None,
            bottom: None,
        };
        assert_eq!(reader.lyrics_rows(1_000.0), none);
        assert_eq!(reader.lay_out(&[10.0; 9], 2.0, 1_000.0).len(), 3);
        assert_eq!(
            reader.lyrics_rows(1_000.0),
            LyricsRows {
                top: Some(0),
                bottom: Some(1)
            }
        );
        assert_eq!(
            reader.lyrics_rows(6_000.0),
            LyricsRows {
                top: Some(2),
                bottom: None
            }
        );
        // A refused layout leaves no display lines.
        assert_eq!(reader.lay_out(&[10.0], 2.0, 1_000.0), vec![]);
        assert_eq!(reader.lyrics_rows(1_000.0), none);
    }

    /// Frames for "Mưa rơi" over the vocabulary of [`ALIGNMENT_VOCABULARY`]:
    /// "Mưa" in frames 1 to 3 and "rơi" in frames 6 to 8, each best token at
    /// probability 0.9.
    fn alignment_frames() -> Vec<f32> {
        let best = [0, 1, 2, 3, 0, 0, 4, 5, 6, 0];
        let rest = (0.1f64 / 6.0).ln() as f32;
        let mut log_probs = vec![rest; 7 * best.len()];
        for (frame, &token) in best.iter().enumerate() {
            log_probs[frame * 7 + token] = 0.9f64.ln() as f32;
        }
        log_probs
    }

    const ALIGNMENT_VOCABULARY: [&str; 7] = ["<pad>", "m", "ư", "a", "r", "\u{1A1}", "i"];

    fn align_known_answer(lyrics: &str) -> Result<Vec<AlignedSyllable>, AlignmentFault> {
        let vocabulary = ALIGNMENT_VOCABULARY.map(str::to_owned).to_vec();
        align(
            lyrics.as_bytes(),
            &alignment_frames(),
            vocabulary,
            0,
            20_000,
            &[],
            1_000,
        )
    }

    #[test]
    fn aligns_the_known_answer() {
        let syllables = align_known_answer("Mưa r\u{1A1}i").expect("it aligns");
        let times: Vec<_> = syllables.iter().map(|s| (s.start_ms, s.end_ms)).collect();
        assert_eq!(times, vec![(20, 120), (120, 180)]);
        assert!(syllables.iter().all(|s| (s.confidence - 0.9).abs() < 1e-6));
    }

    #[test]
    fn alignment_names_the_unknown_syllable() {
        let fault = align_known_answer("Mưa ♪\r\nrơi 2").expect_err("♪ is unknown");
        assert_eq!(fault.lyric_line(), Some(0));
        assert_eq!(fault.syllable(), Some(1));
        let fault = align_known_answer("").expect_err("there are no lyrics");
        assert_eq!(fault, REJECTED);
    }

    #[test]
    fn parses_a_timing_file() {
        let times = parse_timing_file(b"0 100 a\n100 200 b\n", b"a b").expect("it parses");
        let times: Vec<_> = times.iter().map(|t| (t.start_ms, t.end_ms)).collect();
        assert_eq!(times, vec![(0, 100), (100, 200)]);
    }

    #[test]
    fn a_refused_timing_file_names_the_line_and_the_rule() {
        let fault = parse_timing_file(b"100 200 a\n50 300 b\n", b"a b").expect_err("refused");
        assert_eq!(fault.line(), Some(2));
        assert_eq!(fault.kind(), TimingFileErrorKind::Backwards);
        let fault = parse_timing_file(b"0 100 a\n50 200 b\n", b"a b").expect_err("refused");
        assert_eq!(fault.line(), Some(2));
        assert_eq!(fault.kind(), TimingFileErrorKind::Overlap);
        let fault = parse_timing_file(b"0 100 a\n", b"a b").expect_err("refused");
        assert_eq!(fault.line(), Some(2));
        assert_eq!(fault.kind(), TimingFileErrorKind::MissingSyllable);
    }

    #[test]
    fn valid_lyrics_are_accepted_and_anything_else_refused() {
        let fixture = include_bytes!("../../../tests/fixtures/song/lyrics.txt");
        assert!(is_valid_lyrics(fixture));
        assert!(!is_valid_lyrics(b""));
        assert!(!is_valid_lyrics(b"123\n"));
        assert!(!is_valid_lyrics(b"\xff\xfe"));
        assert!(!is_valid_lyrics(b"a\0b"));
    }

    #[test]
    fn a_timing_file_against_invalid_lyrics_is_refused_without_a_line() {
        let fault = parse_timing_file(b"0 100 a\n", b"a\xFF").expect_err("refused");
        assert_eq!(fault.line(), None);
        assert_eq!(fault.kind(), TimingFileErrorKind::Lyrics);
    }

    #[test]
    fn aligner_windows_pad_a_short_song_and_name_a_short_window() {
        let mut windows = AlignerWindows::new(&[1.0; 321], 2).expect("valid");
        assert_eq!(windows.window_count(), 1);
        let audio = windows.window(0).expect("window 0 exists");
        assert_eq!(audio.len(), 480_000);
        assert!(audio[..321].iter().all(|&v| v == 1.0));
        assert!(audio[321..].iter().all(|&v| v == 0.0));
        let fault = windows
            .add_frames(0, &[0.0; 2])
            .expect_err("2 frames are needed");
        assert_eq!(fault.window(), Some(0));
        windows.add_frames(0, &[0.0; 4]).expect("2 frames");
        assert_eq!(windows.finish().expect("every window is in").len(), 4);
        assert_eq!(windows.finish(), Err(NO_WINDOW));
        assert_eq!(windows.window_count(), 0);
        assert_eq!(windows.window(0), Err(NO_WINDOW));
    }

    #[test]
    fn aligner_windows_give_a_frame_of_20_ms() {
        let windows = AlignerWindows::new(&[0.0; 16_000], 4).expect("valid");
        assert_eq!(windows.frame_us(), 20_000);
    }

    #[test]
    fn checks_a_valid_timing() {
        assert_eq!(check_timing(&[0, 500, 500, 1000], b"a b", 1000), Ok(()));
    }

    #[test]
    fn a_timing_check_names_the_rule_it_broke() {
        let kind = |times: &[u32], lyrics: &[u8]| {
            check_timing(times, lyrics, 1000)
                .expect_err("refused")
                .kind()
        };
        assert_eq!(kind(&[0, 500], b"a b"), TimingCheckErrorKind::SyllableCount);
        assert_eq!(
            kind(&[0, 500, 500, 1001], b"a b"),
            TimingCheckErrorKind::PastEnd
        );
        assert_eq!(
            kind(&[0, 500, 400, 1000], b"a b"),
            TimingCheckErrorKind::Times
        );
        assert_eq!(kind(&[0, 500, 500], b"a b"), TimingCheckErrorKind::Times);
        assert_eq!(
            kind(&[0, 500, 500, 1000], b"a\xFF"),
            TimingCheckErrorKind::Lyrics
        );
    }

    /// A writer holding the known-answer example's parts, with `title`,
    /// `lyrics` and `times_ms` in place of the example's.
    fn example_writer(title: &str, lyrics: &[u8], times_ms: &[u32]) -> SongWriter {
        let song_id: Vec<u8> = (0..16).collect();
        let mut writer = SongWriter::new(
            &song_id,
            title.to_owned(),
            String::new(),
            String::new(),
            Role::Female,
            lyrics,
            times_ms,
        );
        writer.set_track(
            TrackKind::Karaoke,
            0,
            "audio/webm; codecs=\"opus\"".to_owned(),
            b"ki",
        );
        writer.add_segment(TrackKind::Karaoke, 1000, 2);
        writer.set_track(
            TrackKind::Original,
            0,
            "audio/mp4; codecs=\"mp4a.40.2\"".to_owned(),
            b"oi",
        );
        writer.add_segment(TrackKind::Original, 1000, 2);
        writer
    }

    /// Writes the whole file in pieces: the head, then each chunk in turn,
    /// with `ks` and `os` as the example's media segments.
    fn write_in_pieces(writer: &mut SongWriter) -> Result<Vec<u8>, SongWriteFault> {
        let mut file = writer.start()?;
        loop {
            match writer.next_chunk()? {
                NextChunk::Core => file.extend(writer.core_chunk()?),
                NextChunk::KaraokeSegment => file.extend(writer.segment(b"ks".to_vec())?),
                NextChunk::OriginalSegment => file.extend(writer.segment(b"os".to_vec())?),
                NextChunk::VideoSegment => file.extend(writer.segment(b"vs".to_vec())?),
                NextChunk::End => return Ok(file),
            }
        }
    }

    #[test]
    fn the_song_writer_gives_the_known_answer_example_from_its_parts() {
        let mut writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1000]);
        assert_eq!(write_in_pieces(&mut writer), Ok(example()));
    }

    #[test]
    fn the_song_writer_refuses_a_call_out_of_turn() {
        let mut writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1000]);
        fn kind<T>(result: Result<T, SongWriteFault>) -> Result<T, SongWriteErrorKind> {
            result.map_err(|fault| fault.kind())
        }
        assert_eq!(kind(writer.next_chunk()), Err(SongWriteErrorKind::Media));
        assert_eq!(
            kind(writer.segment(b"ks".to_vec())),
            Err(SongWriteErrorKind::Media)
        );
        writer.start().expect("a valid song");
        assert_eq!(kind(writer.start()), Err(SongWriteErrorKind::Media));
        assert_eq!(kind(writer.core_chunk()), Err(SongWriteErrorKind::Media));
        // A chunk of the core is next, so a segment is out of turn.
        assert_eq!(kind(writer.next_chunk()), Ok(NextChunk::Core));
        assert_eq!(
            kind(writer.segment(b"ks".to_vec())),
            Err(SongWriteErrorKind::Media)
        );
    }

    #[test]
    fn the_song_writer_refuses_a_segment_of_the_wrong_length() {
        let mut writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1000]);
        writer.start().expect("a valid song");
        while writer.next_chunk() == Ok(NextChunk::Core) {
            writer.core_chunk().expect("a chunk of the core");
        }
        assert_eq!(
            writer
                .segment(b"too long".to_vec())
                .map_err(|fault| fault.kind()),
            Err(SongWriteErrorKind::Media)
        );
    }

    #[test]
    fn the_song_writer_refuses_a_timing_that_ends_after_the_song() {
        let mut writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1500]);
        assert_eq!(
            writer.start().map_err(|fault| fault.kind()),
            Err(SongWriteErrorKind::PastEnd)
        );
    }

    #[test]
    fn the_song_writer_names_the_part_it_refused() {
        let kind = |title: &str, lyrics: &[u8], times: &[u32]| {
            example_writer(title, lyrics, times)
                .start()
                .expect_err("refused")
                .kind()
        };
        let lyrics = "Mưa rơi\n".as_bytes();
        assert_eq!(
            kind("", lyrics, &[0, 500, 500, 1000]),
            SongWriteErrorKind::Details
        );
        assert_eq!(
            kind("Mưa", b"a\xFF", &[0, 500, 500, 1000]),
            SongWriteErrorKind::Lyrics
        );
        assert_eq!(
            kind("Mưa", lyrics, &[0, 500, 500]),
            SongWriteErrorKind::Times
        );
        assert_eq!(
            kind("Mưa", lyrics, &[0, 500]),
            SongWriteErrorKind::SyllableCount
        );
        let mut writer = example_writer("Mưa", lyrics, &[0, 500, 500, 1000]);
        writer.set_track(TrackKind::Video, 0, "video/webm".to_owned(), b"vi");
        assert_eq!(
            writer.start().map_err(|fault| fault.kind()),
            Err(SongWriteErrorKind::Media)
        );
    }

    #[test]
    fn the_song_writer_keeps_the_lyrics_byte_for_byte() {
        // A decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
        let lyrics = "Ha\u{300}  Nội\n".as_bytes();
        let file = write_in_pieces(&mut example_writer("Mưa", lyrics, &[0, 500, 500, 1000]))
            .expect("a valid song");
        let song = song_file::read(&file).expect("the song file reads back");
        assert_eq!(song.lyrics.as_bytes(), lyrics);
    }

    #[test]
    fn aligner_windows_refuse_empty_audio_naming_no_window() {
        assert_eq!(AlignerWindows::new(&[], 2).err(), Some(NO_WINDOW));
    }

    #[test]
    fn aligner_rules_name_the_kind_input_and_output() {
        assert_eq!(
            aligner_rules(AlignerKind::LyricAlignment),
            AlignerRules {
                input_name: "input_values".to_owned(),
                output_name: "log_probs".to_owned(),
            }
        );
    }

    #[test]
    fn aligner_log_probs_passes_whole_frames_and_refuses_others() {
        assert_eq!(
            aligner_log_probs(AlignerKind::LyricAlignment, &[-1.0, -2.0], 2),
            Some(vec![-1.0, -2.0])
        );
        assert_eq!(
            aligner_log_probs(AlignerKind::LyricAlignment, &[0.0; 4], 3),
            None
        );
        assert_eq!(
            aligner_log_probs(AlignerKind::LyricAlignment, &[0.0; 3], 2),
            None
        );
    }

    #[test]
    fn read_vocabulary_reads_the_kind_file() {
        let lyric_alignment = read_vocabulary(
            AlignerKind::LyricAlignment,
            br#"{"|": 0, "a": 1, "<pad>": 2}"#,
        )
        .expect("valid");
        assert_eq!(lyric_alignment.tokens, ["|", "a", "<pad>", "<s>", "</s>"]);
        assert_eq!(lyric_alignment.blank, 2);
    }

    #[test]
    fn a_refused_vocabulary_is_undefined() {
        assert_eq!(
            read_vocabulary(AlignerKind::LyricAlignment, br#"{"a": 0}"#),
            None
        );
    }

    #[test]
    fn a_wrong_magic_is_not_a_song_file() {
        let mut file = example();
        file[0] = 0x88;
        let fault = read(&file).expect_err("the magic is wrong");
        assert!(fault.not_a_song_file());
    }

    #[test]
    fn a_file_too_short_for_a_header_is_not_a_song_file() {
        let fault = read(b"hello").expect_err("five bytes are no header");
        assert!(fault.not_a_song_file());
    }

    #[test]
    fn a_truncated_file_is_damaged() {
        let file = example();
        let fault = read(&file[..248]).expect_err("the last byte is missing");
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn a_timing_that_does_not_match_the_lyrics_is_damaged() {
        let mut file = example();
        file[221] = 0x03;
        let fault = read(&file).expect_err("the timing count is wrong");
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn a_wrong_version_is_damaged() {
        let mut file = example();
        file[8] = 0x01;
        let fault = read(&file).expect_err("the version is not 0");
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn a_position_outside_the_index_is_damaged() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 307.0).expect("valid");
        assert_eq!(reader.read_chunk(7, b"os"), Err(DAMAGED));
    }

    #[test]
    fn a_chunk_of_the_wrong_length_is_damaged() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 307.0).expect("valid");
        assert_eq!(reader.read_chunk(4, b"k"), Err(DAMAGED));
    }

    #[test]
    fn a_device_key_gives_the_vector_code_and_zeroes_the_prf_output() {
        let mut prf: Vec<u8> = (0..32).collect();
        let key = DeviceKey::new(&mut prf).expect("a valid PRF output");
        assert_eq!(
            key.device_code(),
            "lyre1pq2czcfjxetpl79tc2t9k7l75l0xaevqdhv9g28pgd4qwvu0lqswqzflvara"
        );
        assert_eq!(key.fingerprint(), "1458 7998 1818 4050 3333");
        assert_eq!(prf, vec![0; 32]);
    }

    #[test]
    fn a_device_key_gives_a_33_by_33_qr_code_of_zeros_and_ones() {
        let mut prf: Vec<u8> = (0..32).collect();
        let qr = DeviceKey::new(&mut prf).expect("valid").qr_code();
        assert_eq!(qr.size, 33);
        assert_eq!(qr.modules.len(), 33 * 33);
        assert!(qr.modules.iter().all(|&m| m <= 1));
        assert!(qr.modules.contains(&1));
    }

    #[test]
    fn the_prf_salt_is_the_core_salt() {
        assert_eq!(device_prf_salt(), b"lyre/v1/device-key/prf");
    }

    #[test]
    fn a_prf_output_of_the_wrong_length_is_a_fault_and_is_zeroed() {
        let mut prf = vec![5u8; 31];
        let fault = DeviceKey::new(&mut prf).err().expect("31 bytes");
        assert_eq!(fault.kind(), DeviceKeyFaultKind::PrfLength);
        assert_eq!(prf, vec![0; 31]);
    }

    #[test]
    fn reads_a_version_1_song_with_its_access_file_like_the_core() {
        let (core, handle) = device_keys(PRF[0]);
        let build = lyre_cli::build_for_device(fixture_manifest(), &core.public_key())
            .expect("the fixture song builds");
        let song_id = v1::Header::parse(&build.song_file)
            .expect("a version-1 header")
            .song_id();
        let access = access::open(&build.access_file, &core, &song_id).expect("the core opens it");
        let song = v1::read(&build.song_file, &access.content_key).expect("the core reads it");

        let (reader, media) =
            read_encrypted(&build.song_file, &handle, &build.access_file).expect("opens");

        // The media chunks come in the index's order: each track's init, then
        // its segments.
        let mut tracks = Vec::new();
        if let Some(video) = &song.video {
            tracks.push((ChunkKind::VideoInit, ChunkKind::VideoSegment, video));
        }
        tracks.push((
            ChunkKind::KaraokeInit,
            ChunkKind::KaraokeSegment,
            &song.karaoke,
        ));
        tracks.push((
            ChunkKind::OriginalInit,
            ChunkKind::OriginalSegment,
            &song.original,
        ));
        let mut queues: Vec<_> = tracks
            .iter()
            .map(|(init, segment, track)| {
                let mut chunks = std::collections::VecDeque::from([track.init.clone()]);
                chunks.extend(track.segments.iter().map(|s| s.bytes.clone()));
                (*init, *segment, chunks)
            })
            .collect();
        let mut expected_media = Vec::new();
        for entry in reader.entries() {
            if let Some((_, _, chunks)) = queues
                .iter_mut()
                .find(|(init, segment, _)| entry.kind == *init || entry.kind == *segment)
            {
                expected_media.push(chunks.pop_front().expect("a chunk for the entry"));
            }
        }
        assert_eq!(media, expected_media);
        assert_eq!(
            media.len(),
            song.video
                .iter()
                .chain([&song.karaoke, &song.original])
                .map(|t| 1 + t.segments.len())
                .sum::<usize>()
        );

        let mut times = song.timing.syllables().iter();
        let mut expected = Vec::new();
        for line in song.lyrics.lines() {
            for syllable in line.syllables() {
                let time = times.next().expect("a time per syllable");
                expected.push((
                    song.lyrics.as_str()[syllable.range()].to_owned(),
                    time.start_ms,
                    time.end_ms,
                ));
            }
        }
        let syllables: Vec<_> = reader
            .syllables()
            .into_iter()
            .map(|s| (s.text, s.start_ms, s.end_ms))
            .collect();
        assert!(!expected.is_empty());
        assert_eq!(syllables, expected);
        assert_eq!(
            reader.duration_ms(),
            song.karaoke
                .segments
                .iter()
                .map(|s| s.duration_ms)
                .sum::<u32>()
                + song.karaoke.start_ms
        );
    }

    #[test]
    fn a_version_1_song_cannot_be_opened_without_the_right_access_file() {
        let (core, handle) = device_keys(PRF[0]);
        let manifest = fixture_manifest();
        let build = lyre_cli::build_for_device(manifest, &core.public_key()).expect("builds");
        let cannot_open = SongFileFaultKind::CannotOpen;

        assert_eq!(
            kind_of(read_encrypted(&build.song_file, &handle, &[])),
            cannot_open
        );

        let (other_core, _) = device_keys(9);
        let other_device =
            lyre_cli::build_for_device(manifest, &other_core.public_key()).expect("builds");
        assert_eq!(
            kind_of(read_encrypted(
                &build.song_file,
                &handle,
                &other_device.access_file
            )),
            cannot_open
        );

        let other_song = access::wrap(
            &ContentKey::generate(),
            &[0xAA; 16],
            &core.public_key(),
            access::Role::Owner,
        );
        assert_eq!(
            kind_of(read_encrypted(&build.song_file, &handle, &other_song)),
            cannot_open
        );

        // The access file is for this song, but a different key than the file's.
        let song_id = v1::Header::parse(&build.song_file)
            .expect("header")
            .song_id();
        let wrong_key = access::wrap(
            &ContentKey::generate(),
            &song_id,
            &core.public_key(),
            access::Role::Owner,
        );
        assert_eq!(
            kind_of(read_encrypted(&build.song_file, &handle, &wrong_key)),
            cannot_open
        );

        let mut changed = build.song_file.clone();
        changed[v1::HEADER_LEN + 5] ^= 1;
        assert_eq!(
            kind_of(read_encrypted(&changed, &handle, &build.access_file)),
            cannot_open
        );

        let (mut reader, _) =
            read_encrypted(&build.song_file, &handle, &build.access_file).expect("opens");
        let entry = reader.entries()[0];
        let mut chunk = build.song_file
            [entry.offset as usize..entry.offset as usize + entry.length as usize]
            .to_vec();
        chunk[0] ^= 1;
        let fault = reader.read_chunk(0, &chunk).expect_err("a changed chunk");
        assert_eq!(fault.kind(), cannot_open);
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn an_old_version_or_a_wrong_magic_is_told_from_the_rest() {
        let (core, handle) = device_keys(PRF[0]);
        let example = example();
        let old =
            SongReader::open_encrypted(&example[..32], &example[32..200], 307.0, &handle, &[]);
        assert_eq!(kind_of(old), SongFileFaultKind::OldVersion);

        let build =
            lyre_cli::build_for_device(fixture_manifest(), &core.public_key()).expect("builds");
        let mut file = build.song_file.clone();
        file[0] = 0x88;
        let fault = SongReader::header_length(&file).expect_err("the magic is wrong");
        assert_eq!(fault.kind(), SongFileFaultKind::NotASongFile);
        assert_eq!(
            kind_of(read_encrypted(&file, &handle, &build.access_file)),
            SongFileFaultKind::NotASongFile
        );
        assert_eq!(
            kind_of(SongReader::open_encrypted(&file, &[], 0.0, &handle, &[])),
            SongFileFaultKind::NotASongFile
        );
        assert_eq!(
            kind_of(SongReader::header_length(b"hello")),
            SongFileFaultKind::NotASongFile
        );
    }

    #[test]
    fn gives_the_header_and_index_lengths_of_each_version() {
        let example = example();
        assert_eq!(SongReader::header_length(&example), Ok(32));
        assert_eq!(SongReader::index_length(&example[..32]), Ok(168));

        let (core, _) = device_keys(PRF[0]);
        let build =
            lyre_cli::build_for_device(fixture_manifest(), &core.public_key()).expect("builds");
        let header = &build.song_file[..177];
        assert_eq!(SongReader::header_length(&build.song_file), Ok(177));
        let index = v1::Header::parse(header).expect("header").index_len() as u32;
        assert_eq!(SongReader::index_length(header), Ok(index + 16));

        let mut version_2 = build.song_file.clone();
        version_2[8] = 2;
        assert_eq!(
            kind_of(SongReader::header_length(&version_2)),
            SongFileFaultKind::Damaged
        );
    }

    #[test]
    fn a_version_1_file_given_to_the_version_0_open_is_damaged() {
        let (core, _) = device_keys(PRF[0]);
        let build =
            lyre_cli::build_for_device(fixture_manifest(), &core.public_key()).expect("builds");
        let result = SongReader::new(&build.song_file[..32], &build.song_file[32..200], 1000.0);
        assert_eq!(kind_of(result), SongFileFaultKind::Damaged);
    }

    #[test]
    fn no_fault_holds_the_content_key() {
        let key_bytes: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        let hex: String = key_bytes.iter().map(|b| format!("{b:02x}")).collect();
        let content_key = ContentKey::from_bytes(key_bytes);
        let song_id = [3u8; 16];
        let manifest = fixture_manifest();
        let (core, handle) = device_keys(PRF[0]);
        let build = lyre_cli::build_for_device(manifest, &core.public_key()).expect("builds");
        let song = {
            let header = v1::Header::parse(&build.song_file).expect("header");
            let access = access::open(&build.access_file, &core, &header.song_id()).expect("opens");
            v1::read(&build.song_file, &access.content_key).expect("reads")
        };
        let song = song_file::Song { song_id, ..song };
        let recovery = RecoveryKey::from_seed(&[5; 32]).expect("a recovery key");
        let file = v1::write(
            &song,
            &content_key,
            &recovery.public_key(),
            v1::Salt::generate(),
        )
        .expect("writes");
        let access_file = access::wrap(
            &content_key,
            &song_id,
            &core.public_key(),
            access::Role::Owner,
        );

        let mut faults = Vec::new();
        let (_, other) = device_keys(9);
        let other_song = access::wrap(
            &content_key,
            &[4; 16],
            &core.public_key(),
            access::Role::Owner,
        );
        for (device, access) in [
            (&handle, &[][..]),
            (&other, &access_file[..]),
            (&handle, &other_song[..]),
        ] {
            faults.push(
                read_encrypted(&file, device, access)
                    .err()
                    .expect("refused"),
            );
        }
        let mut changed = file.clone();
        changed[v1::HEADER_LEN + 5] ^= 1;
        faults.push(
            read_encrypted(&changed, &handle, &access_file)
                .err()
                .expect("refused"),
        );
        let (mut reader, _) = read_encrypted(&file, &handle, &access_file).expect("opens");
        let entry = reader.entries()[0];
        let mut chunk = file[entry.offset as usize..][..entry.length as usize].to_vec();
        chunk[0] ^= 1;
        faults.push(reader.read_chunk(0, &chunk).expect_err("a changed chunk"));
        faults.push(reader.read_chunk(99, &chunk).expect_err("no such chunk"));
        faults.push(SongReader::header_length(b"x").expect_err("too short"));

        assert_eq!(faults.len(), 7);
        for fault in faults {
            for text in [format!("{fault:?}"), format!("{fault:#?}")] {
                assert!(!text.to_lowercase().contains(&hex), "{text}");
            }
        }
    }
}
