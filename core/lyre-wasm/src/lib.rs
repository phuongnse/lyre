//! WebAssembly bindings of the Lyre core, for the web client.

use lyre_core::lyrics::Lyrics;
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

/// The song's title, artist and composer, exactly as the song file stores
/// them. An empty artist or composer means not known.
#[wasm_bindgen(getter_with_clone, js_name = SongDetails)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Details {
    pub title: String,
    pub artist: String,
    pub composer: String,
}

impl From<&SongDetails> for Details {
    fn from(details: &SongDetails) -> Details {
        Details {
            title: details.title().to_owned(),
            artist: details.artist().to_owned(),
            composer: details.composer().to_owned(),
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

#[cfg(test)]
mod tests {
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
        assert_eq!(bytes.len(), 248);
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

    #[test]
    fn core_version_returns_the_core_version() {
        assert_eq!(core_version(), lyre_core::version());
    }

    #[test]
    fn reads_the_known_answer_example() {
        let file = example();
        let header = &file[..32];
        assert_eq!(SongReader::index_length(header), Ok(7 * 24));
        let reader = SongReader::new(header, &file[32..200], 248.0).expect("the example is valid");
        assert_eq!(reader.duration_ms(), 1_000);
        let entries = reader.entries();
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries[4],
            ChunkEntry {
                kind: ChunkKind::KaraokeSegment,
                offset: 242,
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
            })
        );
    }

    #[test]
    fn has_no_details_before_their_chunk_is_read() {
        let file = example();
        let reader = SongReader::new(&file[..32], &file[32..200], 248.0).expect("valid");
        assert_eq!(reader.details(), None);
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
        let fault = read(&file[..247]).expect_err("the last byte is missing");
        assert!(!fault.not_a_song_file());
    }

    #[test]
    fn a_timing_that_does_not_match_the_lyrics_is_damaged() {
        let mut file = example();
        file[220] = 0x03;
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
        let mut reader = SongReader::new(&file[..32], &file[32..200], 248.0).expect("valid");
        assert_eq!(reader.read_chunk(7, b"os"), Err(DAMAGED));
    }

    #[test]
    fn a_chunk_of_the_wrong_length_is_damaged() {
        let file = example();
        let mut reader = SongReader::new(&file[..32], &file[32..200], 248.0).expect("valid");
        assert_eq!(reader.read_chunk(4, b"k"), Err(DAMAGED));
    }
}
