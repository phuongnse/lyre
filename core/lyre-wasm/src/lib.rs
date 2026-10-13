//! WebAssembly bindings of the Lyre core, for the web client.

use lyre_core::countdown;
use lyre_core::display_lines::{self, DisplayLine, MeasuredSyllable};
use lyre_core::highlight;
use lyre_core::lyrics::Lyrics;
use lyre_core::lyrics_rows;
use lyre_core::model;
use lyre_core::song_file::{
    self, Chunk, ChunkType, Header, Index, IndexEntry, SongDetails, SongFileError, Timing,
};
use wasm_bindgen::prelude::wasm_bindgen;

/// The version of the Lyre core.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    lyre_core::version().to_owned()
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
        // A checked index ends within MAX_FILE_SIZE, 2³¹ − 1, so offsets fit.
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
            .collect::<Result<_, _>>()?;
        Ok(SongReader {
            song_id: header.song_id(),
            index,
            entries,
            details: None,
            lyrics: None,
            timing: None,
            display_lines: Vec::new(),
        })
    }

    /// The song's duration: the total of the karaoke track's segments.
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

    /// Checks the `bytes` of the chunk at `position` in the index. Returns
    /// the bytes of a media chunk, and nothing for any other chunk. Once the
    /// lyrics and the timing are both read, it checks one against the other.
    #[wasm_bindgen(js_name = readChunk)]
    pub fn read_chunk(
        &mut self,
        position: u32,
        bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, SongFileFault> {
        let entry = usize::try_from(position)
            .ok()
            .and_then(|position| self.index.entries().get(position))
            .ok_or(DAMAGED)?;
        match song_file::read_chunk(entry, bytes)? {
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
        assert_eq!(bytes.len(), 249);
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
    fn an_unknown_model_gives_no_check() {
        assert!(ModelCheck::start("no-such-model").is_none());
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
        let reader = SongReader::new(header, &file[32..200], 249.0).expect("the example is valid");
        assert_eq!(reader.duration_ms(), 1_000);
        let entries = reader.entries();
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries[4],
            ChunkEntry {
                kind: ChunkKind::KaraokeSegment,
                offset: 243,
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
        let reader = SongReader::new(&file[..32], &file[32..200], 249.0).expect("valid");
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
        let mut reader = SongReader::new(&file[..32], &file[32..200], 249.0).expect("valid");
        assert_eq!(reader.syllables(), vec![]);
        assert_eq!(reader.lay_out(&[10.0, 10.0], 2.0, 100.0), vec![]);
        assert_eq!(reader.sweep_position(250.0), 0.0);
        assert_eq!(reader.countdown_lines(), vec![]);
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
            reader.lyrics_rows(5_000.0),
            LyricsRows {
                top: Some(2),
                bottom: None
            }
        );
        // A refused layout leaves no display lines.
        assert_eq!(reader.lay_out(&[10.0], 2.0, 1_000.0), vec![]);
        assert_eq!(reader.lyrics_rows(1_000.0), none);
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
        let mut reader = SongReader::new(&file[..32], &file[32..200], 249.0).expect("valid");
        assert_eq!(reader.read_chunk(7, b"os"), Err(DAMAGED));
    }

    #[test]
    fn a_chunk_of_the_wrong_length_is_damaged() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 249.0).expect("valid");
        assert_eq!(reader.read_chunk(4, b"k"), Err(DAMAGED));
    }
}
