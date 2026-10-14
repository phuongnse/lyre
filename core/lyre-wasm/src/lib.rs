//! WebAssembly bindings of the Lyre core, for the web client.

use lyre_core::aligner;
use lyre_core::alignment::{self, AlignmentError, Emissions};
use lyre_core::alignment_windows::{self, WindowError};
use lyre_core::countdown;
use lyre_core::display_lines::{self, DisplayLine, MeasuredSyllable};
use lyre_core::highlight;
use lyre_core::lyrics::Lyrics;
use lyre_core::lyrics_rows;
use lyre_core::mel_roformer::{self, BrokenRun, SeparationError};
use lyre_core::model;
use lyre_core::song_file::{
    self, Chunk, ChunkType, Header, Index, IndexEntry, Segment, Song, SongDetails, SongFileError,
    SyllableTime, Timing, Track,
};
use lyre_core::timing_file::{self, TimingErrorKind, TimingFileError};
use wasm_bindgen::prelude::wasm_bindgen;

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

/// Why a song file was refused. It holds no core message, because those are
/// not meant for users.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SongFileFault {
    not_a_song_file: bool,
}

#[wasm_bindgen]
impl SongFileFault {
    /// True when the file is not a song file at all: too short for a header
    /// or with the wrong magic. False when it is damaged or incomplete.
    #[wasm_bindgen(getter, js_name = notASongFile)]
    pub fn not_a_song_file(&self) -> bool {
        self.not_a_song_file
    }
}

impl From<SongFileError> for SongFileFault {
    fn from(error: SongFileError) -> SongFileFault {
        SongFileFault {
            not_a_song_file: matches!(
                error,
                SongFileError::HeaderTooShort { .. } | SongFileError::BadMagic
            ),
        }
    }
}

/// The fault for a file that is damaged or incomplete.
const DAMAGED: SongFileFault = SongFileFault {
    not_a_song_file: false,
};

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

/// Collects the parts of one song, then writes them as a song file through
/// the core's writer, so the client never lays out song file bytes. Every
/// check happens in [`SongWriter::write`]. The lyrics are kept exactly as
/// supplied (D5).
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
    video: Option<Track>,
    karaoke: Track,
    original: Track,
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
            karaoke: Track::default(),
            original: Track::default(),
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
        *self.track(kind) = Track {
            start_ms,
            stored_type,
            init: init.to_vec(),
            segments: Vec::new(),
        };
    }

    /// Adds a media segment to the end of a track.
    #[wasm_bindgen(js_name = addSegment)]
    pub fn add_segment(&mut self, kind: TrackKind, duration_ms: u32, bytes: &[u8]) {
        self.track(kind).segments.push(Segment {
            duration_ms,
            bytes: bytes.to_vec(),
        });
    }

    /// Writes the song file, or names the part the core refused.
    pub fn write(&self) -> Result<Vec<u8>, SongWriteFault> {
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
        let song = Song {
            song_id,
            details,
            thumbnail: self.thumbnail.clone(),
            lyrics,
            timing,
            video: self.video.clone(),
            karaoke: self.karaoke.clone(),
            original: self.original.clone(),
        };
        Ok(song_file::write(&song)?)
    }
}

impl SongWriter {
    fn track(&mut self, kind: TrackKind) -> &mut Track {
        match kind {
            TrackKind::Video => self.video.get_or_insert_with(Track::default),
            TrackKind::Karaoke => &mut self.karaoke,
            TrackKind::Original => &mut self.original,
        }
    }
}

/// Reads a song file the way the format's reading model says: the header,
/// then the index with the file size, then one chunk at a time. The client
/// passes the bytes. The reader never needs the whole file.
#[wasm_bindgen]
pub struct SongReader {
    song_id: [u8; 16],
    index: Index,
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
    /// The length of the index that follows the 32-byte `header`.
    #[wasm_bindgen(js_name = indexLength)]
    pub fn index_length(header: &[u8]) -> Result<u32, SongFileFault> {
        let header = Header::parse(header)?;
        u32::try_from(header.index_len()).map_err(|_| DAMAGED)
    }

    /// Checks the `header` and the `index` against the total `file_size`.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8], index: &[u8], file_size: f64) -> Result<SongReader, SongFileFault> {
        let header = Header::parse(header)?;
        // A size that is negative, fractional or too large becomes one the
        // index check rejects or compares exactly.
        let index = Index::parse(&header, index, file_size as u64)?;
        let entries = index
            .entries()
            .iter()
            .map(ChunkEntry::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SongReader {
            song_id: header.song_id(),
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
        let entry = self.index.entries().get(position).ok_or(DAMAGED)?;
        match song_file::read_chunk(entry, bytes)? {
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

#[cfg(test)]
mod tests {
    use std::path::Path;

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
        writer.add_segment(TrackKind::Karaoke, 1000, b"ks");
        writer.set_track(
            TrackKind::Original,
            0,
            "audio/mp4; codecs=\"mp4a.40.2\"".to_owned(),
            b"oi",
        );
        writer.add_segment(TrackKind::Original, 1000, b"os");
        writer
    }

    #[test]
    fn the_song_writer_gives_the_known_answer_example_from_its_parts() {
        let writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1000]);
        assert_eq!(writer.write(), Ok(example()));
    }

    #[test]
    fn the_song_writer_refuses_a_timing_that_ends_after_the_song() {
        let writer = example_writer("Mưa", "Mưa rơi\n".as_bytes(), &[0, 500, 500, 1500]);
        assert_eq!(
            writer.write().map_err(|fault| fault.kind()),
            Err(SongWriteErrorKind::PastEnd)
        );
    }

    #[test]
    fn the_song_writer_names_the_part_it_refused() {
        let kind = |title: &str, lyrics: &[u8], times: &[u32]| {
            example_writer(title, lyrics, times)
                .write()
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
            writer.write().map_err(|fault| fault.kind()),
            Err(SongWriteErrorKind::Media)
        );
    }

    #[test]
    fn the_song_writer_keeps_the_lyrics_byte_for_byte() {
        // A decomposed "Hà" (NFD), two spaces, then a precomposed "Nội" (NFC).
        let lyrics = "Ha\u{300}  Nội\n".as_bytes();
        let file = example_writer("Mưa", lyrics, &[0, 500, 500, 1000])
            .write()
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
}
