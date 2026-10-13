//! Song files, format version 0: writing and reading `.lyre` files.
//!
//! The byte layout, the rules and the limits are in
//! `docs/reference/song-file-format-v0.md`. Reading follows its reading
//! model: [`Header::parse`] reads the 32-byte header, [`Index::parse`] checks
//! the index against the file size, and [`read_chunk`] parses each chunk from
//! the bytes at its index entry. The core never needs the whole file.
//! [`read`] does all three on a file held in memory.
//!
//! Every value is checked against the limits, and a file that breaks any
//! rule is rejected as a whole. No error message quotes the lyrics or the
//! song details.

use std::fmt;
use std::ops::Range;

use crate::lyrics::{Lyrics, LyricsError, MAX_LYRICS_BYTES};

/// The first 8 bytes of every song file.
pub const MAGIC: [u8; 8] = [0x89, b'L', b'Y', b'R', b'E', 0x0D, 0x0A, 0x1A];
/// The format version this module reads and writes.
pub const VERSION: u16 = 0;
/// The size of the header, in bytes.
pub const HEADER_LEN: usize = 32;
/// The size of one index entry, in bytes.
pub const INDEX_ENTRY_LEN: usize = 24;
/// The fewest index entries a song file can have.
pub const MIN_ENTRY_COUNT: u32 = 7;
/// The most index entries a song file can have.
pub const MAX_ENTRY_COUNT: u32 = 16_384;
/// The largest song file, in bytes (2³¹ − 1).
pub const MAX_FILE_SIZE: u64 = 2_147_483_647;
/// The largest title, artist or composer, in bytes.
pub const MAX_FIELD_BYTES: usize = 1_024;
/// The smallest song details chunk: a 1-byte title, two empty fields and
/// the vocal role.
pub const MIN_DETAILS_BYTES: usize = 8;
/// The largest song details chunk: three full fields with their lengths, and
/// the vocal role.
pub const MAX_DETAILS_BYTES: usize = 3 * (2 + MAX_FIELD_BYTES) + 1;
/// The largest thumbnail, in bytes.
pub const MAX_THUMBNAIL_BYTES: usize = 1_048_576;
/// The most syllables a timing chunk can hold.
pub const MAX_SYLLABLES: usize = 65_536;
/// The smallest timing chunk: a count and one syllable.
pub const MIN_TIMING_BYTES: usize = 4 + 8;
/// The largest timing chunk: a count and [`MAX_SYLLABLES`] syllables.
pub const MAX_TIMING_BYTES: usize = 4 + 8 * MAX_SYLLABLES;
/// The largest init segment chunk, in bytes.
pub const MAX_INIT_BYTES: usize = 65_536;
/// The largest media segment chunk, in bytes (16 MiB).
pub const MAX_SEGMENT_BYTES: usize = 16_777_216;
/// The longest media segment, in milliseconds.
pub const MAX_SEGMENT_MS: u32 = 10_000;
/// The most media segments in one track.
pub const MAX_SEGMENTS: usize = 4_096;
/// The longest song, in milliseconds (1 hour).
pub const MAX_SONG_MS: u32 = 3_600_000;
/// How far the video's duration may differ from the song's, in milliseconds.
pub const VIDEO_TOLERANCE_MS: u32 = 1_000;

/// The parsed header of a song file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    song_id: [u8; 16],
    entry_count: u32,
}

impl Header {
    /// Parses the first 32 bytes of `bytes`. Bytes after them are ignored.
    pub fn parse(bytes: &[u8]) -> Result<Header, SongFileError> {
        let short = SongFileError::HeaderTooShort { len: bytes.len() };
        if bytes.len() < HEADER_LEN {
            return Err(short);
        }
        let mut reader = Reader::new(bytes);
        let magic = reader.take(MAGIC.len()).ok_or(short.clone())?;
        if magic != MAGIC {
            return Err(SongFileError::BadMagic);
        }
        let version = reader.u16().ok_or(short.clone())?;
        if version != VERSION {
            return Err(SongFileError::UnsupportedVersion { version });
        }
        let reserved = reader.u16().ok_or(short.clone())?;
        if reserved != 0 {
            return Err(SongFileError::HeaderReserved { value: reserved });
        }
        let entry_count = reader.u32().ok_or(short.clone())?;
        if !(MIN_ENTRY_COUNT..=MAX_ENTRY_COUNT).contains(&entry_count) {
            return Err(SongFileError::EntryCount {
                count: u64::from(entry_count),
            });
        }
        let song_id = reader
            .take(16)
            .and_then(|id| id.try_into().ok())
            .ok_or(short)?;
        Ok(Header {
            song_id,
            entry_count,
        })
    }

    /// The song's ID.
    pub fn song_id(&self) -> [u8; 16] {
        self.song_id
    }

    /// The number of index entries.
    pub fn entry_count(&self) -> u32 {
        self.entry_count
    }

    /// The length of the index that follows the header, in bytes.
    pub fn index_len(&self) -> usize {
        // `entry_count` is at most MAX_ENTRY_COUNT, so this cannot overflow.
        usize::try_from(self.entry_count).map_or(usize::MAX, |count| count * INDEX_ENTRY_LEN)
    }
}

/// The type of a chunk, as stored in its index entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum ChunkType {
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

impl ChunkType {
    /// The chunk type stored as `code`, if there is one.
    pub fn from_code(code: u16) -> Option<ChunkType> {
        Some(match code {
            1 => ChunkType::SongDetails,
            2 => ChunkType::Thumbnail,
            3 => ChunkType::Lyrics,
            4 => ChunkType::Timing,
            16 => ChunkType::VideoInit,
            17 => ChunkType::VideoSegment,
            18 => ChunkType::KaraokeInit,
            19 => ChunkType::KaraokeSegment,
            20 => ChunkType::OriginalInit,
            21 => ChunkType::OriginalSegment,
            _ => return None,
        })
    }

    /// The number stored in the index for this type.
    pub fn code(self) -> u16 {
        self as u16
    }

    /// Whether chunks of this type are media segments, with a start and a
    /// duration.
    pub fn is_segment(self) -> bool {
        matches!(
            self,
            ChunkType::VideoSegment | ChunkType::KaraokeSegment | ChunkType::OriginalSegment
        )
    }

    /// The smallest and largest stored length of chunks of this type.
    fn length_limits(self) -> (usize, usize) {
        match self {
            ChunkType::SongDetails => (MIN_DETAILS_BYTES, MAX_DETAILS_BYTES),
            ChunkType::Thumbnail => (1, MAX_THUMBNAIL_BYTES),
            ChunkType::Lyrics => (1, MAX_LYRICS_BYTES),
            ChunkType::Timing => (MIN_TIMING_BYTES, MAX_TIMING_BYTES),
            ChunkType::VideoInit | ChunkType::KaraokeInit | ChunkType::OriginalInit => {
                (1, MAX_INIT_BYTES)
            }
            ChunkType::VideoSegment | ChunkType::KaraokeSegment | ChunkType::OriginalSegment => {
                (1, MAX_SEGMENT_BYTES)
            }
        }
    }
}

/// One index entry: where a chunk is stored and, for a media segment, when
/// it plays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub chunk_type: ChunkType,
    pub length: u32,
    pub offset: u64,
    pub start_ms: u32,
    pub duration_ms: u32,
}

/// A checked index: every structural rule of the format holds for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Index {
    entries: Vec<IndexEntry>,
    duration_ms: u32,
}

impl Index {
    /// Parses the index `bytes` that follow `header` and checks them against
    /// the total `file_size`.
    pub fn parse(header: &Header, bytes: &[u8], file_size: u64) -> Result<Index, SongFileError> {
        if bytes.len() != header.index_len() {
            return Err(SongFileError::IndexLength {
                len: bytes.len(),
                expected: header.index_len(),
            });
        }
        if file_size > MAX_FILE_SIZE {
            return Err(SongFileError::FileTooLarge { size: file_size });
        }
        let entries = bytes
            .as_chunks::<INDEX_ENTRY_LEN>()
            .0
            .iter()
            .enumerate()
            .map(|(position, raw)| decode_entry(position, raw))
            .collect::<Result<Vec<_>, _>>()?;
        let duration_ms = validate(&entries, file_size)?;
        Ok(Index {
            entries,
            duration_ms,
        })
    }

    /// The entries, in the order the chunks are stored.
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    /// The song's duration: the total of the karaoke track's segments.
    pub fn duration_ms(&self) -> u32 {
        self.duration_ms
    }
}

/// Who sings the song. A song file records one role for the whole song, so
/// this covers solo songs. Roles per lyric line are planned for M8.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum VocalRole {
    Male = 1,
    Female = 2,
}

impl VocalRole {
    /// The vocal role stored as `code`, if there is one.
    pub fn from_code(code: u8) -> Option<VocalRole> {
        Some(match code {
            1 => VocalRole::Male,
            2 => VocalRole::Female,
            _ => return None,
        })
    }

    /// The number stored in the song details for this role.
    pub fn code(self) -> u8 {
        self as u8
    }
}

/// The song's title, artist and composer, each stored as supplied, and its
/// vocal role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SongDetails {
    title: String,
    artist: String,
    composer: String,
    vocal_role: VocalRole,
}

impl SongDetails {
    /// Accepts the details when the title has 1 to 1,024 bytes, the artist
    /// and the composer 0 to 1,024 bytes, and none holds a NUL character.
    /// An empty artist or composer means not known.
    pub fn new(
        title: String,
        artist: String,
        composer: String,
        vocal_role: VocalRole,
    ) -> Result<SongDetails, SongFileError> {
        check_field(DetailField::Title, &title, 1)?;
        check_field(DetailField::Artist, &artist, 0)?;
        check_field(DetailField::Composer, &composer, 0)?;
        Ok(SongDetails {
            title,
            artist,
            composer,
            vocal_role,
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// The artist, or an empty string when not known.
    pub fn artist(&self) -> &str {
        &self.artist
    }

    /// The composer, or an empty string when not known.
    pub fn composer(&self) -> &str {
        &self.composer
    }

    pub fn vocal_role(&self) -> VocalRole {
        self.vocal_role
    }
}

/// When one syllable is sung, in milliseconds from the start of the song.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyllableTime {
    pub start_ms: u32,
    pub end_ms: u32,
}

/// The timing: one time per syllable, in lyric order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timing {
    syllables: Vec<SyllableTime>,
}

impl Timing {
    /// Accepts 1 to 65,536 syllable times where each starts before it ends
    /// and none overlaps the next.
    pub fn new(syllables: Vec<SyllableTime>) -> Result<Timing, SongFileError> {
        if !(1..=MAX_SYLLABLES).contains(&syllables.len()) {
            return Err(SongFileError::SyllableCount {
                count: syllables.len(),
            });
        }
        if let Some(index) = syllables.iter().position(|s| s.start_ms >= s.end_ms) {
            return Err(SongFileError::SyllableOrder { index });
        }
        if let Some(index) = syllables
            .windows(2)
            .position(|pair| pair[0].end_ms > pair[1].start_ms)
        {
            return Err(SongFileError::SyllableOverlap { index: index + 1 });
        }
        Ok(Timing { syllables })
    }

    /// The syllable times, in lyric order.
    pub fn syllables(&self) -> &[SyllableTime] {
        &self.syllables
    }
}

/// One media segment of a track. Its start is the total of the durations of
/// the segments before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub duration_ms: u32,
    pub bytes: Vec<u8>,
}

/// One media track: its init segment and its media segments, in order. The
/// core treats the bytes as opaque.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Track {
    pub init: Vec<u8>,
    pub segments: Vec<Segment>,
}

/// Every part of one song, as a song file holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Song {
    pub song_id: [u8; 16],
    pub details: SongDetails,
    pub thumbnail: Option<Vec<u8>>,
    pub lyrics: Lyrics,
    pub timing: Timing,
    pub video: Option<Track>,
    pub karaoke: Track,
    pub original: Track,
}

/// The parsed content of one chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    SongDetails(SongDetails),
    Thumbnail(Vec<u8>),
    Lyrics(Lyrics),
    Timing(Timing),
    /// An init segment or a media segment, as opaque bytes.
    Media(Vec<u8>),
}

/// Parses the chunk `bytes` that `entry` points to. `bytes` must be exactly
/// the chunk's stored length.
pub fn read_chunk(entry: &IndexEntry, bytes: &[u8]) -> Result<Chunk, SongFileError> {
    if usize::try_from(entry.length) != Ok(bytes.len()) {
        return Err(SongFileError::ChunkBytes {
            chunk_type: entry.chunk_type.code(),
            len: bytes.len(),
            expected: entry.length,
        });
    }
    check_length(entry.chunk_type, entry.length)?;
    match entry.chunk_type {
        ChunkType::SongDetails => parse_details(bytes).map(Chunk::SongDetails),
        ChunkType::Thumbnail => Ok(Chunk::Thumbnail(bytes.to_vec())),
        ChunkType::Lyrics => Lyrics::parse(bytes)
            .map(Chunk::Lyrics)
            .map_err(SongFileError::Lyrics),
        ChunkType::Timing => parse_timing(bytes).map(Chunk::Timing),
        _ => Ok(Chunk::Media(bytes.to_vec())),
    }
}

/// Checks the timing against the lyrics and the song's duration: one time
/// per syllable, and the last syllable ends by the end of the song.
pub fn check_timing(timing: &Timing, lyrics: &Lyrics, song_ms: u32) -> Result<(), SongFileError> {
    let expected: usize = lyrics
        .lines()
        .iter()
        .map(|line| line.syllables().len())
        .sum();
    if timing.syllables.len() != expected {
        return Err(SongFileError::SyllableMismatch {
            count: timing.syllables.len(),
            expected,
        });
    }
    if let Some(last) = timing.syllables.last()
        && last.end_ms > song_ms
    {
        return Err(SongFileError::TimingPastEnd {
            end_ms: last.end_ms,
            song_ms,
        });
    }
    Ok(())
}

/// Reads a whole song file held in memory.
pub fn read(file: &[u8]) -> Result<Song, SongFileError> {
    let header = Header::parse(file)?;
    let index_bytes = file
        .get(HEADER_LEN..HEADER_LEN + header.index_len())
        .ok_or(SongFileError::IndexLength {
            len: file.len().saturating_sub(HEADER_LEN),
            expected: header.index_len(),
        })?;
    let index = Index::parse(&header, index_bytes, file.len() as u64)?;

    let mut details = None;
    let mut thumbnail = None;
    let mut lyrics = None;
    let mut timing = None;
    let mut video: Option<Track> = None;
    let mut karaoke = Track::default();
    let mut original = Track::default();
    for entry in index.entries() {
        let bytes = chunk_bytes(file, entry).ok_or(SongFileError::FileSize {
            size: file.len() as u64,
            end: entry.offset.saturating_add(u64::from(entry.length)),
        })?;
        match read_chunk(entry, bytes)? {
            Chunk::SongDetails(chunk) => details = Some(chunk),
            Chunk::Thumbnail(chunk) => thumbnail = Some(chunk),
            Chunk::Lyrics(chunk) => lyrics = Some(chunk),
            Chunk::Timing(chunk) => timing = Some(chunk),
            Chunk::Media(bytes) => {
                let track = match entry.chunk_type {
                    ChunkType::VideoInit | ChunkType::VideoSegment => {
                        video.get_or_insert_with(Track::default)
                    }
                    ChunkType::KaraokeInit | ChunkType::KaraokeSegment => &mut karaoke,
                    _ => &mut original,
                };
                if entry.chunk_type.is_segment() {
                    track.segments.push(Segment {
                        duration_ms: entry.duration_ms,
                        bytes,
                    });
                } else {
                    track.init = bytes;
                }
            }
        }
    }
    let missing = |chunk_type: ChunkType| SongFileError::MissingChunk {
        chunk_type: chunk_type.code(),
    };
    let lyrics = lyrics.ok_or(missing(ChunkType::Lyrics))?;
    let timing = timing.ok_or(missing(ChunkType::Timing))?;
    check_timing(&timing, &lyrics, index.duration_ms())?;
    Ok(Song {
        song_id: header.song_id(),
        details: details.ok_or(missing(ChunkType::SongDetails))?,
        thumbnail,
        lyrics,
        timing,
        video,
        karaoke,
        original,
    })
}

/// Writes `song` as a song file. A song that the reader would reject is
/// refused before any file bytes are written.
pub fn write(song: &Song) -> Result<Vec<u8>, SongFileError> {
    let details = encode_details(&song.details)?;
    let timing = encode_timing(&song.timing)?;
    let mut chunks: Vec<(ChunkType, &[u8], u32)> =
        vec![(ChunkType::SongDetails, details.as_slice(), 0)];
    if let Some(thumbnail) = &song.thumbnail {
        chunks.push((ChunkType::Thumbnail, thumbnail, 0));
    }
    chunks.push((ChunkType::Lyrics, song.lyrics.as_bytes(), 0));
    chunks.push((ChunkType::Timing, &timing, 0));
    if let Some(video) = &song.video {
        push_track(
            &mut chunks,
            video,
            ChunkType::VideoInit,
            ChunkType::VideoSegment,
        );
    }
    push_track(
        &mut chunks,
        &song.karaoke,
        ChunkType::KaraokeInit,
        ChunkType::KaraokeSegment,
    );
    push_track(
        &mut chunks,
        &song.original,
        ChunkType::OriginalInit,
        ChunkType::OriginalSegment,
    );

    let parts: Vec<_> = chunks
        .iter()
        .map(|&(chunk_type, bytes, duration_ms)| (chunk_type, bytes.len(), duration_ms))
        .collect();
    let (entries, file_size) = layout(&parts)?;
    let song_ms = validate(&entries, file_size)?;
    check_timing(&song.timing, &song.lyrics, song_ms)?;

    let capacity =
        usize::try_from(file_size).map_err(|_| SongFileError::FileTooLarge { size: file_size })?;
    let mut file = Vec::with_capacity(capacity);
    file.extend_from_slice(&MAGIC);
    file.extend_from_slice(&VERSION.to_le_bytes());
    file.extend_from_slice(&0u16.to_le_bytes());
    let entry_count = u32::try_from(entries.len()).map_err(|_| SongFileError::EntryCount {
        count: entries.len() as u64,
    })?;
    file.extend_from_slice(&entry_count.to_le_bytes());
    file.extend_from_slice(&song.song_id);
    for entry in &entries {
        file.extend_from_slice(&entry.chunk_type.code().to_le_bytes());
        file.extend_from_slice(&0u16.to_le_bytes());
        file.extend_from_slice(&entry.length.to_le_bytes());
        file.extend_from_slice(&entry.offset.to_le_bytes());
        file.extend_from_slice(&entry.start_ms.to_le_bytes());
        file.extend_from_slice(&entry.duration_ms.to_le_bytes());
    }
    for (_, bytes, _) in &chunks {
        file.extend_from_slice(bytes);
    }
    Ok(file)
}

/// Adds a track's init segment and media segments to the chunks to write.
fn push_track<'a>(
    chunks: &mut Vec<(ChunkType, &'a [u8], u32)>,
    track: &'a Track,
    init: ChunkType,
    segment: ChunkType,
) {
    chunks.push((init, &track.init, 0));
    for part in &track.segments {
        chunks.push((segment, &part.bytes, part.duration_ms));
    }
}

/// A field of the song details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailField {
    Title,
    Artist,
    Composer,
    VocalRole,
}

impl fmt::Display for DetailField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            DetailField::Title => "title",
            DetailField::Artist => "artist",
            DetailField::Composer => "composer",
            DetailField::VocalRole => "vocal role",
        })
    }
}

/// Why a song file, or a part of one, was rejected. Each variant names one
/// rule of the format. Messages carry only numbers, never lyric text or song
/// details. Index positions count from 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SongFileError {
    /// Fewer than 32 bytes were given for the header.
    HeaderTooShort { len: usize },
    /// The file does not start with the song file magic.
    BadMagic,
    /// The format version is not 0.
    UnsupportedVersion { version: u16 },
    /// The header's reserved field is not 0.
    HeaderReserved { value: u16 },
    /// The number of index entries is outside 7 to 16,384.
    EntryCount { count: u64 },
    /// The index bytes are not `entry_count × 24` long.
    IndexLength { len: usize, expected: usize },
    /// The file is larger than 2,147,483,647 bytes.
    FileTooLarge { size: u64 },
    /// An index entry has a chunk type the format does not define.
    UnknownChunkType { position: usize, chunk_type: u16 },
    /// An index entry's reserved field is not 0.
    EntryReserved { position: usize, value: u16 },
    /// A chunk of this type is not allowed at this place in the index.
    ChunkOrder { position: usize, chunk_type: u16 },
    /// A chunk that must be present is missing.
    MissingChunk { chunk_type: u16 },
    /// A track has a number of media segments outside 1 to 4,096.
    SegmentCount { chunk_type: u16, count: usize },
    /// A chunk's stored length is outside the limits for its type.
    ChunkLength { chunk_type: u16, length: u64 },
    /// A chunk does not start where the previous one ends.
    ChunkOffset {
        position: usize,
        offset: u64,
        expected: u64,
    },
    /// The last chunk does not end at the end of the file.
    FileSize { size: u64, end: u64 },
    /// A chunk that is not a media segment has a nonzero start or duration.
    UnusedTimes { position: usize },
    /// A media segment's duration is outside 1 to 10,000 ms.
    SegmentDuration { position: usize, duration_ms: u32 },
    /// A media segment does not start where the previous one in its track
    /// ends.
    SegmentStart {
        position: usize,
        start_ms: u32,
        expected: u64,
    },
    /// The original track has a different number of segments than the
    /// karaoke track.
    TrackLengths { karaoke: usize, original: usize },
    /// An original segment's start or duration differs from its karaoke
    /// segment's.
    SegmentMismatch { position: usize },
    /// The song's duration is outside 1 to 3,600,000 ms.
    SongDuration { duration_ms: u64 },
    /// The video's duration is more than 1,000 ms from the song's.
    VideoDuration { video_ms: u64, song_ms: u64 },
    /// The bytes given for a chunk are not its stored length.
    ChunkBytes {
        chunk_type: u16,
        len: usize,
        expected: u32,
    },
    /// The song details chunk ends inside a field.
    DetailsTruncated { field: DetailField },
    /// Bytes are left after the vocal role.
    DetailsTrailingBytes { count: usize },
    /// The vocal role byte is not a known role.
    UnknownVocalRole { value: u8 },
    /// A song details field has a length outside its limits.
    FieldLength { field: DetailField, len: usize },
    /// A song details field is not valid UTF-8. `offset` is the length of
    /// the valid prefix.
    FieldInvalidUtf8 { field: DetailField, offset: usize },
    /// A song details field contains a NUL character at byte `offset`.
    FieldNul { field: DetailField, offset: usize },
    /// The timing chunk is not `4 + 8 × count` bytes.
    TimingLength { len: usize, count: u32 },
    /// The timing has a number of syllables outside 1 to 65,536.
    SyllableCount { count: usize },
    /// A syllable does not start before it ends.
    SyllableOrder { index: usize },
    /// A syllable starts before the previous one ends.
    SyllableOverlap { index: usize },
    /// The timing does not have one time per syllable of the lyrics.
    SyllableMismatch { count: usize, expected: usize },
    /// The last syllable ends after the end of the song.
    TimingPastEnd { end_ms: u32, song_ms: u32 },
    /// The lyrics chunk was rejected.
    Lyrics(LyricsError),
}

impl fmt::Display for SongFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SongFileError::HeaderTooShort { len } => {
                write!(
                    f,
                    "header needs {HEADER_LEN} bytes, but only {len} were given"
                )
            }
            SongFileError::BadMagic => write!(f, "not a song file: the magic is wrong"),
            SongFileError::UnsupportedVersion { version } => {
                write!(f, "song file version {version} is not supported")
            }
            SongFileError::HeaderReserved { value } => {
                write!(f, "header reserved field is {value}, not 0")
            }
            SongFileError::EntryCount { count } => write!(
                f,
                "index has {count} entries, outside {MIN_ENTRY_COUNT} to {MAX_ENTRY_COUNT}"
            ),
            SongFileError::IndexLength { len, expected } => {
                write!(f, "index is {len} bytes, not the expected {expected}")
            }
            SongFileError::FileTooLarge { size } => write!(
                f,
                "file is {size} bytes, over the limit of {MAX_FILE_SIZE} bytes"
            ),
            SongFileError::UnknownChunkType {
                position,
                chunk_type,
            } => write!(
                f,
                "index entry {position} has unknown chunk type {chunk_type}"
            ),
            SongFileError::EntryReserved { position, value } => {
                write!(f, "index entry {position} reserved field is {value}, not 0")
            }
            SongFileError::ChunkOrder {
                position,
                chunk_type,
            } => write!(
                f,
                "index entry {position} has chunk type {chunk_type}, which is not allowed there"
            ),
            SongFileError::MissingChunk { chunk_type } => {
                write!(f, "a chunk of type {chunk_type} is missing")
            }
            SongFileError::SegmentCount { chunk_type, count } => write!(
                f,
                "track has {count} segments of type {chunk_type}, outside 1 to {MAX_SEGMENTS}"
            ),
            SongFileError::ChunkLength { chunk_type, length } => write!(
                f,
                "chunk of type {chunk_type} is {length} bytes, outside the limits for its type"
            ),
            SongFileError::ChunkOffset {
                position,
                offset,
                expected,
            } => write!(
                f,
                "index entry {position} starts at offset {offset}, not at {expected}"
            ),
            SongFileError::FileSize { size, end } => write!(
                f,
                "last chunk ends at byte {end}, but the file is {size} bytes"
            ),
            SongFileError::UnusedTimes { position } => write!(
                f,
                "index entry {position} is not a media segment but has a start or duration"
            ),
            SongFileError::SegmentDuration {
                position,
                duration_ms,
            } => write!(
                f,
                "index entry {position} lasts {duration_ms} ms, outside 1 to {MAX_SEGMENT_MS} ms"
            ),
            SongFileError::SegmentStart {
                position,
                start_ms,
                expected,
            } => write!(
                f,
                "index entry {position} starts at {start_ms} ms, not at {expected} ms"
            ),
            SongFileError::TrackLengths { karaoke, original } => write!(
                f,
                "original track has {original} segments, but the karaoke track has {karaoke}"
            ),
            SongFileError::SegmentMismatch { position } => write!(
                f,
                "original segment at index entry {position} is not cut at the karaoke segment's times"
            ),
            SongFileError::SongDuration { duration_ms } => write!(
                f,
                "song lasts {duration_ms} ms, outside 1 to {MAX_SONG_MS} ms"
            ),
            SongFileError::VideoDuration { video_ms, song_ms } => write!(
                f,
                "video lasts {video_ms} ms, more than {VIDEO_TOLERANCE_MS} ms from the song's {song_ms} ms"
            ),
            SongFileError::ChunkBytes {
                chunk_type,
                len,
                expected,
            } => write!(
                f,
                "chunk of type {chunk_type} was given {len} bytes, not its stored {expected}"
            ),
            SongFileError::DetailsTruncated { field } => {
                write!(f, "song details end inside the {field}")
            }
            SongFileError::DetailsTrailingBytes { count } => {
                write!(f, "song details have {count} bytes after the vocal role")
            }
            SongFileError::UnknownVocalRole { value } => {
                write!(f, "vocal role {value} is not known")
            }
            SongFileError::FieldLength { field, len } => write!(
                f,
                "{field} is {len} bytes, outside the limits for the {field}"
            ),
            SongFileError::FieldInvalidUtf8 { field, offset } => {
                write!(f, "{field} is not valid UTF-8 at byte {offset}")
            }
            SongFileError::FieldNul { field, offset } => {
                write!(f, "{field} contains a NUL character at byte {offset}")
            }
            SongFileError::TimingLength { len, count } => write!(
                f,
                "timing chunk is {len} bytes, not 4 + 8 × {count} for its {count} syllables"
            ),
            SongFileError::SyllableCount { count } => write!(
                f,
                "timing has {count} syllables, outside 1 to {MAX_SYLLABLES}"
            ),
            SongFileError::SyllableOrder { index } => {
                write!(f, "syllable {index} does not start before it ends")
            }
            SongFileError::SyllableOverlap { index } => {
                write!(f, "syllable {index} starts before the previous one ends")
            }
            SongFileError::SyllableMismatch { count, expected } => write!(
                f,
                "timing has {count} syllables, but the lyrics have {expected}"
            ),
            SongFileError::TimingPastEnd { end_ms, song_ms } => write!(
                f,
                "last syllable ends at {end_ms} ms, after the song's end at {song_ms} ms"
            ),
            SongFileError::Lyrics(err) => write!(f, "lyrics chunk rejected: {err}"),
        }
    }
}

impl std::error::Error for SongFileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SongFileError::Lyrics(err) => Some(err),
            _ => None,
        }
    }
}

/// Reads little-endian integers and byte runs from the front of a slice.
/// Each read returns `None`, and takes nothing, when too few bytes are left.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes }
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (taken, rest) = self.bytes.split_at_checked(len)?;
        self.bytes = rest;
        Some(taken)
    }

    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        self.take(N)?.try_into().ok()
    }

    fn u8(&mut self) -> Option<u8> {
        self.array().map(u8::from_le_bytes)
    }

    fn u16(&mut self) -> Option<u16> {
        self.array().map(u16::from_le_bytes)
    }

    fn u32(&mut self) -> Option<u32> {
        self.array().map(u32::from_le_bytes)
    }

    fn u64(&mut self) -> Option<u64> {
        self.array().map(u64::from_le_bytes)
    }

    fn remaining(&self) -> usize {
        self.bytes.len()
    }
}

/// Decodes the 24 bytes of the index entry at `position`.
fn decode_entry(position: usize, raw: &[u8]) -> Result<IndexEntry, SongFileError> {
    let short = SongFileError::IndexLength {
        len: raw.len(),
        expected: INDEX_ENTRY_LEN,
    };
    let mut reader = Reader::new(raw);
    let code = reader.u16().ok_or(short.clone())?;
    let chunk_type = ChunkType::from_code(code).ok_or(SongFileError::UnknownChunkType {
        position,
        chunk_type: code,
    })?;
    let reserved = reader.u16().ok_or(short.clone())?;
    if reserved != 0 {
        return Err(SongFileError::EntryReserved {
            position,
            value: reserved,
        });
    }
    Ok(IndexEntry {
        chunk_type,
        length: reader.u32().ok_or(short.clone())?,
        offset: reader.u64().ok_or(short.clone())?,
        start_ms: reader.u32().ok_or(short.clone())?,
        duration_ms: reader.u32().ok_or(short)?,
    })
}

/// Lays out chunks of the given (type, length, duration) one after another
/// after the header and the index. Each media segment starts where the
/// previous segment of its track ends. Returns the index entries and the
/// file size.
fn layout(parts: &[(ChunkType, usize, u32)]) -> Result<(Vec<IndexEntry>, u64), SongFileError> {
    let count = parts.len() as u64;
    if !(u64::from(MIN_ENTRY_COUNT)..=u64::from(MAX_ENTRY_COUNT)).contains(&count) {
        return Err(SongFileError::EntryCount { count });
    }
    let mut offset = (HEADER_LEN + INDEX_ENTRY_LEN * parts.len()) as u64;
    let mut start_ms = 0u64;
    let mut entries = Vec::with_capacity(parts.len());
    for &(chunk_type, len, duration_ms) in parts {
        let length = u32::try_from(len).map_err(|_| SongFileError::ChunkLength {
            chunk_type: chunk_type.code(),
            length: len as u64,
        })?;
        let entry = if chunk_type.is_segment() {
            // A start that does not fit follows a segment that is too long,
            // which `validate` rejects first.
            let start = u32::try_from(start_ms).unwrap_or(u32::MAX);
            start_ms += u64::from(duration_ms);
            IndexEntry {
                chunk_type,
                length,
                offset,
                start_ms: start,
                duration_ms,
            }
        } else {
            start_ms = 0;
            IndexEntry {
                chunk_type,
                length,
                offset,
                start_ms: 0,
                duration_ms: 0,
            }
        };
        offset = offset
            .checked_add(u64::from(length))
            .ok_or(SongFileError::FileTooLarge { size: u64::MAX })?;
        entries.push(entry);
    }
    Ok((entries, offset))
}

/// The positions of each track's media segments in the index.
struct Tracks {
    video: Option<Range<usize>>,
    karaoke: Range<usize>,
    original: Range<usize>,
}

/// Walks the index entries in the order the chunk types table sets.
struct Cursor<'a> {
    entries: &'a [IndexEntry],
    position: usize,
}

impl Cursor<'_> {
    /// Steps over the next entry if it has type `chunk_type`.
    fn optional(&mut self, chunk_type: ChunkType) -> bool {
        let found = self
            .entries
            .get(self.position)
            .is_some_and(|entry| entry.chunk_type == chunk_type);
        if found {
            self.position += 1;
        }
        found
    }

    /// Steps over the next entry, which must have type `chunk_type`.
    fn expect(&mut self, chunk_type: ChunkType) -> Result<(), SongFileError> {
        if self.optional(chunk_type) {
            return Ok(());
        }
        Err(match self.entries.get(self.position) {
            Some(entry) => SongFileError::ChunkOrder {
                position: self.position,
                chunk_type: entry.chunk_type.code(),
            },
            None => SongFileError::MissingChunk {
                chunk_type: chunk_type.code(),
            },
        })
    }

    /// Steps over a track's 1 to 4,096 media segments of type `chunk_type`.
    fn segments(&mut self, chunk_type: ChunkType) -> Result<Range<usize>, SongFileError> {
        let start = self.position;
        while self.optional(chunk_type) {}
        let count = self.position - start;
        if !(1..=MAX_SEGMENTS).contains(&count) {
            return Err(SongFileError::SegmentCount {
                chunk_type: chunk_type.code(),
                count,
            });
        }
        Ok(start..self.position)
    }
}

/// Checks the chunk types, their order and their counts.
fn check_order(entries: &[IndexEntry]) -> Result<Tracks, SongFileError> {
    let mut cursor = Cursor {
        entries,
        position: 0,
    };
    cursor.expect(ChunkType::SongDetails)?;
    cursor.optional(ChunkType::Thumbnail);
    cursor.expect(ChunkType::Lyrics)?;
    cursor.expect(ChunkType::Timing)?;
    let video = if cursor.optional(ChunkType::VideoInit) {
        Some(cursor.segments(ChunkType::VideoSegment)?)
    } else {
        None
    };
    cursor.expect(ChunkType::KaraokeInit)?;
    let karaoke = cursor.segments(ChunkType::KaraokeSegment)?;
    cursor.expect(ChunkType::OriginalInit)?;
    let original = cursor.segments(ChunkType::OriginalSegment)?;
    if let Some(entry) = entries.get(cursor.position) {
        return Err(SongFileError::ChunkOrder {
            position: cursor.position,
            chunk_type: entry.chunk_type.code(),
        });
    }
    Ok(Tracks {
        video,
        karaoke,
        original,
    })
}

/// Checks a chunk's stored length against the limits for its type.
fn check_length(chunk_type: ChunkType, length: u32) -> Result<(), SongFileError> {
    let (min, max) = chunk_type.length_limits();
    let fits = usize::try_from(length).is_ok_and(|len| {
        (min..=max).contains(&len) && (chunk_type != ChunkType::Timing || (len - 4) % 8 == 0)
    });
    if fits {
        Ok(())
    } else {
        Err(SongFileError::ChunkLength {
            chunk_type: chunk_type.code(),
            length: u64::from(length),
        })
    }
}

/// Checks that a track's segments last 1 to 10,000 ms each and follow on
/// from 0 without gaps. Returns the track's total duration.
fn track_ms(entries: &[IndexEntry], segments: Range<usize>) -> Result<u64, SongFileError> {
    let mut end = 0u64;
    for (position, entry) in segments.clone().zip(&entries[segments]) {
        if !(1..=MAX_SEGMENT_MS).contains(&entry.duration_ms) {
            return Err(SongFileError::SegmentDuration {
                position,
                duration_ms: entry.duration_ms,
            });
        }
        if u64::from(entry.start_ms) != end {
            return Err(SongFileError::SegmentStart {
                position,
                start_ms: entry.start_ms,
                expected: end,
            });
        }
        end += u64::from(entry.duration_ms);
    }
    Ok(end)
}

/// Checks every structural rule of the index against the file size. Both
/// the reader and the writer use it. Returns the song's duration.
fn validate(entries: &[IndexEntry], file_size: u64) -> Result<u32, SongFileError> {
    let count = entries.len() as u64;
    if !(u64::from(MIN_ENTRY_COUNT)..=u64::from(MAX_ENTRY_COUNT)).contains(&count) {
        return Err(SongFileError::EntryCount { count });
    }
    if file_size > MAX_FILE_SIZE {
        return Err(SongFileError::FileTooLarge { size: file_size });
    }
    let tracks = check_order(entries)?;

    let mut expected = (HEADER_LEN + INDEX_ENTRY_LEN * entries.len()) as u64;
    for (position, entry) in entries.iter().enumerate() {
        check_length(entry.chunk_type, entry.length)?;
        if entry.offset != expected {
            return Err(SongFileError::ChunkOffset {
                position,
                offset: entry.offset,
                expected,
            });
        }
        if !entry.chunk_type.is_segment() && (entry.start_ms != 0 || entry.duration_ms != 0) {
            return Err(SongFileError::UnusedTimes { position });
        }
        expected = expected
            .checked_add(u64::from(entry.length))
            .ok_or(SongFileError::FileTooLarge { size: u64::MAX })?;
    }
    if expected != file_size {
        return Err(SongFileError::FileSize {
            size: file_size,
            end: expected,
        });
    }

    let song_ms = track_ms(entries, tracks.karaoke.clone())?;
    track_ms(entries, tracks.original.clone())?;
    if tracks.karaoke.len() != tracks.original.len() {
        return Err(SongFileError::TrackLengths {
            karaoke: tracks.karaoke.len(),
            original: tracks.original.len(),
        });
    }
    for (position, (karaoke, original)) in tracks.original.clone().zip(
        entries[tracks.karaoke]
            .iter()
            .zip(&entries[tracks.original]),
    ) {
        if karaoke.start_ms != original.start_ms || karaoke.duration_ms != original.duration_ms {
            return Err(SongFileError::SegmentMismatch { position });
        }
    }
    if !(1..=u64::from(MAX_SONG_MS)).contains(&song_ms) {
        return Err(SongFileError::SongDuration {
            duration_ms: song_ms,
        });
    }
    if let Some(video) = tracks.video {
        let video_ms = track_ms(entries, video)?;
        if video_ms.abs_diff(song_ms) > u64::from(VIDEO_TOLERANCE_MS) {
            return Err(SongFileError::VideoDuration { video_ms, song_ms });
        }
    }
    u32::try_from(song_ms).map_err(|_| SongFileError::SongDuration {
        duration_ms: song_ms,
    })
}

/// The bytes of the chunk that `entry` points to, if the file holds them.
fn chunk_bytes<'a>(file: &'a [u8], entry: &IndexEntry) -> Option<&'a [u8]> {
    let start = usize::try_from(entry.offset).ok()?;
    let end = start.checked_add(usize::try_from(entry.length).ok()?)?;
    file.get(start..end)
}

/// Checks one song details field: its length and that it has no NUL.
fn check_field(field: DetailField, value: &str, min: usize) -> Result<(), SongFileError> {
    if !(min..=MAX_FIELD_BYTES).contains(&value.len()) {
        return Err(SongFileError::FieldLength {
            field,
            len: value.len(),
        });
    }
    if let Some(offset) = value.bytes().position(|byte| byte == 0) {
        return Err(SongFileError::FieldNul { field, offset });
    }
    Ok(())
}

fn parse_details(bytes: &[u8]) -> Result<SongDetails, SongFileError> {
    let mut reader = Reader::new(bytes);
    let mut read_field = |field| {
        let truncated = SongFileError::DetailsTruncated { field };
        let len = reader.u16().ok_or(truncated.clone())?;
        let raw = reader.take(usize::from(len)).ok_or(truncated)?;
        std::str::from_utf8(raw)
            .map(str::to_owned)
            .map_err(|err| SongFileError::FieldInvalidUtf8 {
                field,
                offset: err.valid_up_to(),
            })
    };
    let title = read_field(DetailField::Title)?;
    let artist = read_field(DetailField::Artist)?;
    let composer = read_field(DetailField::Composer)?;
    let code = reader.u8().ok_or(SongFileError::DetailsTruncated {
        field: DetailField::VocalRole,
    })?;
    let vocal_role =
        VocalRole::from_code(code).ok_or(SongFileError::UnknownVocalRole { value: code })?;
    if reader.remaining() != 0 {
        return Err(SongFileError::DetailsTrailingBytes {
            count: reader.remaining(),
        });
    }
    SongDetails::new(title, artist, composer, vocal_role)
}

fn encode_details(details: &SongDetails) -> Result<Vec<u8>, SongFileError> {
    let fields = [
        (DetailField::Title, &details.title),
        (DetailField::Artist, &details.artist),
        (DetailField::Composer, &details.composer),
    ];
    let mut bytes = Vec::new();
    for (field, value) in fields {
        let len = u16::try_from(value.len()).map_err(|_| SongFileError::FieldLength {
            field,
            len: value.len(),
        })?;
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.push(details.vocal_role.code());
    Ok(bytes)
}

fn parse_timing(bytes: &[u8]) -> Result<Timing, SongFileError> {
    let mut reader = Reader::new(bytes);
    let truncated = SongFileError::TimingLength {
        len: bytes.len(),
        count: 0,
    };
    let count = reader.u32().ok_or(truncated)?;
    if u64::from(count) * 8 + 4 != bytes.len() as u64 {
        return Err(SongFileError::TimingLength {
            len: bytes.len(),
            count,
        });
    }
    let mut syllables = Vec::new();
    while let (Some(start_ms), Some(end_ms)) = (reader.u32(), reader.u32()) {
        syllables.push(SyllableTime { start_ms, end_ms });
    }
    Timing::new(syllables)
}

fn encode_timing(timing: &Timing) -> Result<Vec<u8>, SongFileError> {
    let count =
        u32::try_from(timing.syllables.len()).map_err(|_| SongFileError::SyllableCount {
            count: timing.syllables.len(),
        })?;
    let mut bytes = Vec::with_capacity(4 + 8 * timing.syllables.len());
    bytes.extend_from_slice(&count.to_le_bytes());
    for syllable in &timing.syllables {
        bytes.extend_from_slice(&syllable.start_ms.to_le_bytes());
        bytes.extend_from_slice(&syllable.end_ms.to_le_bytes());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORMAT_DOC: &str = include_str!("../../../docs/reference/song-file-format-v0.md");

    /// The known-answer example, read from the format doc's hex dump so the
    /// tests keep no second copy of its bytes.
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
            let (address, rest) = line.split_once(": ").expect("an xxd line");
            assert_eq!(
                usize::from_str_radix(address, 16),
                Ok(bytes.len()),
                "{line}"
            );
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

    fn details(title: &str, artist: &str, composer: &str, vocal_role: VocalRole) -> SongDetails {
        SongDetails::new(
            title.to_owned(),
            artist.to_owned(),
            composer.to_owned(),
            vocal_role,
        )
        .expect("details are accepted")
    }

    fn lyrics(text: &str) -> Lyrics {
        Lyrics::parse(text.as_bytes()).expect("lyrics are accepted")
    }

    fn timing(times: &[(u32, u32)]) -> Timing {
        Timing::new(
            times
                .iter()
                .map(|&(start_ms, end_ms)| SyllableTime { start_ms, end_ms })
                .collect(),
        )
        .expect("timing is accepted")
    }

    fn track(init: &[u8], segments: &[(u32, &[u8])]) -> Track {
        Track {
            init: init.to_vec(),
            segments: segments
                .iter()
                .map(|&(duration_ms, bytes)| Segment {
                    duration_ms,
                    bytes: bytes.to_vec(),
                })
                .collect(),
        }
    }

    /// The song the known-answer example holds.
    fn example_song() -> Song {
        Song {
            song_id: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            details: details("Mưa", "", "", VocalRole::Female),
            thumbnail: None,
            lyrics: lyrics("Mưa rơi\n"),
            timing: timing(&[(0, 500), (500, 1000)]),
            video: None,
            karaoke: track(b"ki", &[(1000, b"ks")]),
            original: track(b"oi", &[(1000, b"os")]),
        }
    }

    /// Chunk (type, length, duration) lists, checked without allocating the
    /// chunks themselves.
    type Parts = Vec<(ChunkType, usize, u32)>;

    /// The parts of a song with the example's first chunks and the given
    /// tracks, each segment as (length, duration).
    fn parts(
        video: Option<&[(usize, u32)]>,
        karaoke: &[(usize, u32)],
        original: &[(usize, u32)],
    ) -> Parts {
        let mut parts = vec![
            (ChunkType::SongDetails, 11, 0),
            (ChunkType::Lyrics, 10, 0),
            (ChunkType::Timing, 20, 0),
        ];
        let mut push = |init, segment, segments: &[(usize, u32)]| {
            parts.push((init, 2, 0));
            for &(len, duration_ms) in segments {
                parts.push((segment, len, duration_ms));
            }
        };
        if let Some(video) = video {
            push(ChunkType::VideoInit, ChunkType::VideoSegment, video);
        }
        push(ChunkType::KaraokeInit, ChunkType::KaraokeSegment, karaoke);
        push(
            ChunkType::OriginalInit,
            ChunkType::OriginalSegment,
            original,
        );
        parts
    }

    /// The parts of the known-answer example.
    fn example_parts() -> Parts {
        parts(None, &[(2, 1000)], &[(2, 1000)])
    }

    /// The example's parts with the first chunk of `chunk_type` set to `len`
    /// bytes. A thumbnail is added after the song details.
    fn with_length(chunk_type: ChunkType, len: usize) -> Parts {
        let mut parts = example_parts();
        if chunk_type == ChunkType::Thumbnail {
            parts.insert(1, (ChunkType::Thumbnail, len, 0));
        } else {
            let part = parts
                .iter_mut()
                .find(|part| part.0 == chunk_type)
                .expect("the example has the chunk");
            part.1 = len;
        }
        parts
    }

    /// Lays out `parts` and checks the index against the file size.
    fn check(parts: &[(ChunkType, usize, u32)]) -> Result<u32, SongFileError> {
        let (entries, file_size) = layout(parts)?;
        validate(&entries, file_size)
    }

    fn chunk_length_error(chunk_type: ChunkType, length: usize) -> SongFileError {
        SongFileError::ChunkLength {
            chunk_type: chunk_type.code(),
            length: length as u64,
        }
    }

    fn entry(chunk_type: ChunkType, length: usize) -> IndexEntry {
        IndexEntry {
            chunk_type,
            length: u32::try_from(length).expect("a u32 length"),
            offset: 0,
            start_ms: 0,
            duration_ms: 0,
        }
    }

    /// Song details with the given fields and the vocal role female.
    fn encoded_details(title: &[u8], artist: &[u8], composer: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for field in [title, artist, composer] {
            let len = u16::try_from(field.len()).expect("a u16 length");
            bytes.extend_from_slice(&len.to_le_bytes());
            bytes.extend_from_slice(field);
        }
        bytes.push(VocalRole::Female.code());
        bytes
    }

    fn read_details(bytes: &[u8]) -> Result<Chunk, SongFileError> {
        read_chunk(&entry(ChunkType::SongDetails, bytes.len()), bytes)
    }

    #[test]
    fn reads_the_known_answer_example() {
        let song = read(&example()).expect("the example is valid");
        assert_eq!(song, example_song());
        assert_eq!(song.details.title(), "Mưa");
        assert_eq!(song.details.artist(), "");
        assert_eq!(song.details.composer(), "");
        assert_eq!(song.details.vocal_role(), VocalRole::Female);
        assert_eq!(song.lyrics.as_bytes(), "Mưa rơi\n".as_bytes());
        assert_eq!(song.lyrics.lines().len(), 1);
    }

    #[test]
    fn writes_the_known_answer_example() {
        assert_eq!(write(&example_song()), Ok(example()));
    }

    #[test]
    fn reads_the_example_header_index_and_chunks_separately() {
        let file = example();
        let header = Header::parse(&file[..HEADER_LEN]).expect("the header is valid");
        assert_eq!(header.song_id(), example_song().song_id);
        assert_eq!(header.entry_count(), 7);
        assert_eq!(header.index_len(), 168);

        let index_bytes = &file[HEADER_LEN..HEADER_LEN + header.index_len()];
        let index = Index::parse(&header, index_bytes, 249).expect("the index is valid");
        assert_eq!(index.duration_ms(), 1000);
        let types: Vec<_> = index.entries().iter().map(|e| e.chunk_type).collect();
        assert_eq!(
            types,
            [
                ChunkType::SongDetails,
                ChunkType::Lyrics,
                ChunkType::Timing,
                ChunkType::KaraokeInit,
                ChunkType::KaraokeSegment,
                ChunkType::OriginalInit,
                ChunkType::OriginalSegment,
            ]
        );

        let chunks: Vec<_> = index
            .entries()
            .iter()
            .map(|entry| {
                let start = usize::try_from(entry.offset).expect("a small offset");
                let end = start + usize::try_from(entry.length).expect("a small length");
                // Each chunk gets only its own bytes, as a client reading a
                // byte range would pass.
                read_chunk(entry, &file[start..end]).expect("the chunk is valid")
            })
            .collect();
        let song = example_song();
        assert_eq!(
            chunks,
            [
                Chunk::SongDetails(song.details),
                Chunk::Lyrics(song.lyrics.clone()),
                Chunk::Timing(song.timing.clone()),
                Chunk::Media(b"ki".to_vec()),
                Chunk::Media(b"ks".to_vec()),
                Chunk::Media(b"oi".to_vec()),
                Chunk::Media(b"os".to_vec()),
            ]
        );
        assert_eq!(
            check_timing(&song.timing, &song.lyrics, index.duration_ms()),
            Ok(())
        );
    }

    #[test]
    fn round_trips_every_part_with_lyrics_byte_for_byte() {
        let text = "\u{FEFF}Mưa rơi\r\nla";
        let song = Song {
            song_id: [0xAB; 16],
            details: details("Mưa", "Ca sĩ", "Nhạc sĩ", VocalRole::Male),
            thumbnail: Some(b"\xFF\xD8\xFF\xE0thumb".to_vec()),
            lyrics: lyrics(text),
            timing: timing(&[(0, 300), (300, 600), (700, 1000)]),
            video: Some(track(b"vi", &[(700, b"vs1"), (800, b"vs2")])),
            karaoke: track(b"ki", &[(600, b"ks1"), (400, b"ks2")]),
            original: track(b"oi", &[(600, b"os1"), (400, b"os2")]),
        };
        let file = write(&song).expect("the song is valid");
        let read_back = read(&file).expect("the written file is valid");
        assert_eq!(read_back, song);
        assert_eq!(read_back.lyrics.as_bytes(), text.as_bytes());
        assert_eq!(&read_back.lyrics.as_bytes()[..3], b"\xEF\xBB\xBF");

        let header = Header::parse(&file).expect("the header is valid");
        let index_bytes = &file[HEADER_LEN..HEADER_LEN + header.index_len()];
        let index = Index::parse(&header, index_bytes, file.len() as u64).expect("valid");
        let starts: Vec<_> = index
            .entries()
            .iter()
            .filter(|entry| entry.chunk_type.is_segment())
            .map(|entry| (entry.chunk_type, entry.start_ms, entry.duration_ms))
            .collect();
        assert_eq!(
            starts,
            [
                (ChunkType::VideoSegment, 0, 700),
                (ChunkType::VideoSegment, 700, 800),
                (ChunkType::KaraokeSegment, 0, 600),
                (ChunkType::KaraokeSegment, 600, 400),
                (ChunkType::OriginalSegment, 0, 600),
                (ChunkType::OriginalSegment, 600, 400),
            ]
        );
    }

    #[test]
    fn rejects_the_invalid_variants_in_the_doc() {
        let mut bad_magic = example();
        bad_magic[0] = 0x88;
        assert_eq!(read(&bad_magic), Err(SongFileError::BadMagic));

        let mut version_1 = example();
        version_1[8..10].copy_from_slice(&[0x01, 0x00]);
        assert_eq!(
            read(&version_1),
            Err(SongFileError::UnsupportedVersion { version: 1 })
        );

        let mut truncated = example();
        truncated.pop();
        assert_eq!(
            read(&truncated),
            Err(SongFileError::FileSize {
                size: 248,
                end: 249
            })
        );

        let mut padded = example();
        padded.push(0);
        assert_eq!(
            read(&padded),
            Err(SongFileError::FileSize {
                size: 250,
                end: 249
            })
        );

        let mut timing_count_3 = example();
        timing_count_3[221] = 0x03;
        assert_eq!(
            read(&timing_count_3),
            Err(SongFileError::TimingLength { len: 20, count: 3 })
        );

        let mut original_999 = example();
        original_999[196] = 0xE7;
        assert_eq!(
            read(&original_999),
            Err(SongFileError::SegmentMismatch { position: 6 })
        );

        let mut unknown_role = example();
        unknown_role[210] = 0x03;
        assert_eq!(
            read(&unknown_role),
            Err(SongFileError::UnknownVocalRole { value: 3 })
        );
    }

    #[test]
    fn rejects_every_truncation_of_the_example() {
        let file = example();
        for len in 0..file.len() {
            assert!(read(&file[..len]).is_err(), "prefix of {len} bytes");
        }
    }

    #[test]
    fn rejects_any_changed_header_or_index_byte() {
        let file = example();
        let header_and_index = (0..16).chain(HEADER_LEN..200);
        for offset in header_and_index {
            for mask in [0x01, 0xFF] {
                let mut changed = file.clone();
                changed[offset] ^= mask;
                assert!(read(&changed).is_err(), "byte {offset} ^ {mask:#04x}");
            }
        }
    }

    #[test]
    fn any_song_id_is_valid() {
        let mut file = example();
        file[16..32].copy_from_slice(&[0xFF; 16]);
        let song = read(&file).expect("any 16 bytes are a song ID");
        assert_eq!(song.song_id, [0xFF; 16]);
    }

    #[test]
    fn header_is_exactly_32_bytes() {
        let file = example();
        assert_eq!(
            Header::parse(&file[..31]),
            Err(SongFileError::HeaderTooShort { len: 31 })
        );
        assert!(Header::parse(&file[..32]).is_ok());
    }

    #[test]
    fn index_entries_are_exactly_24_bytes() {
        let file = example();
        let header = Header::parse(&file).expect("the header is valid");
        assert_eq!(
            Index::parse(&header, &file[32..199], 249),
            Err(SongFileError::IndexLength {
                len: 167,
                expected: 168
            })
        );
        assert_eq!(
            Index::parse(&header, &file[32..201], 249),
            Err(SongFileError::IndexLength {
                len: 169,
                expected: 168
            })
        );
    }

    #[test]
    fn entry_count_is_7_to_16384() {
        let header_with = |count: u32| {
            let mut file = example();
            file[12..16].copy_from_slice(&count.to_le_bytes());
            Header::parse(&file)
        };
        assert_eq!(header_with(6), Err(SongFileError::EntryCount { count: 6 }));
        assert_eq!(
            header_with(16_385),
            Err(SongFileError::EntryCount { count: 16_385 })
        );
        assert_eq!(header_with(16_384).map(|h| h.index_len()), Ok(393_216));
        assert_eq!(
            check(&example_parts()[..6]),
            Err(SongFileError::EntryCount { count: 6 })
        );
    }

    #[test]
    fn file_size_is_at_most_2_gib_minus_1() {
        // 128 segments in each track, with the karaoke track's last segment
        // sized so the file ends 1 byte past the limit.
        let mut karaoke = vec![(MAX_SEGMENT_BYTES, 1000); 128];
        let original = vec![(1, 1000); 128];
        let (_, size) = layout(&parts(None, &karaoke, &original)).expect("laid out");
        let over = usize::try_from(size - (MAX_FILE_SIZE + 1)).expect("small");
        karaoke[127].0 -= over;
        let over_limit = parts(None, &karaoke, &original);
        assert_eq!(
            check(&over_limit),
            Err(SongFileError::FileTooLarge {
                size: MAX_FILE_SIZE + 1
            })
        );
        karaoke[127].0 -= 1;
        assert_eq!(check(&parts(None, &karaoke, &original)), Ok(128_000));

        let file = example();
        let header = Header::parse(&file).expect("the header is valid");
        assert_eq!(
            Index::parse(&header, &file[32..200], MAX_FILE_SIZE + 1),
            Err(SongFileError::FileTooLarge {
                size: MAX_FILE_SIZE + 1
            })
        );
    }

    #[test]
    fn song_details_chunk_is_8_to_3079_bytes() {
        assert_eq!(
            check(&with_length(ChunkType::SongDetails, 3_080)),
            Err(chunk_length_error(ChunkType::SongDetails, 3_080))
        );
        assert_eq!(
            check(&with_length(ChunkType::SongDetails, 7)),
            Err(chunk_length_error(ChunkType::SongDetails, 7))
        );
        assert!(check(&with_length(ChunkType::SongDetails, 3_079)).is_ok());
        assert!(check(&with_length(ChunkType::SongDetails, 8)).is_ok());

        let full = encoded_details(&[b'a'; 1024], &[b'b'; 1024], &[b'c'; 1024]);
        assert_eq!(full.len(), MAX_DETAILS_BYTES);
        assert!(read_details(&full).is_ok());
        let mut over = full.clone();
        over.push(0);
        assert_eq!(
            read_details(&over),
            Err(chunk_length_error(ChunkType::SongDetails, 3_080))
        );
    }

    #[test]
    fn title_is_1_to_1024_bytes() {
        let over = "a".repeat(1_025);
        assert_eq!(
            SongDetails::new(over.clone(), String::new(), String::new(), VocalRole::Male),
            Err(SongFileError::FieldLength {
                field: DetailField::Title,
                len: 1_025
            })
        );
        assert_eq!(
            SongDetails::new(String::new(), String::new(), String::new(), VocalRole::Male),
            Err(SongFileError::FieldLength {
                field: DetailField::Title,
                len: 0
            })
        );
        assert_eq!(
            read_details(&encoded_details(over.as_bytes(), b"", b"")),
            Err(SongFileError::FieldLength {
                field: DetailField::Title,
                len: 1_025
            })
        );
        assert!(
            SongDetails::new(
                "a".repeat(1_024),
                String::new(),
                String::new(),
                VocalRole::Male
            )
            .is_ok()
        );
    }

    #[test]
    fn artist_and_composer_are_at_most_1024_bytes() {
        let over = "a".repeat(1_025);
        assert_eq!(
            SongDetails::new("t".to_owned(), over.clone(), String::new(), VocalRole::Male),
            Err(SongFileError::FieldLength {
                field: DetailField::Artist,
                len: 1_025
            })
        );
        assert_eq!(
            SongDetails::new("t".to_owned(), String::new(), over.clone(), VocalRole::Male),
            Err(SongFileError::FieldLength {
                field: DetailField::Composer,
                len: 1_025
            })
        );
        assert_eq!(
            read_details(&encoded_details(b"t", over.as_bytes(), b"")),
            Err(SongFileError::FieldLength {
                field: DetailField::Artist,
                len: 1_025
            })
        );
        assert_eq!(
            read_details(&encoded_details(b"t", b"", over.as_bytes())),
            Err(SongFileError::FieldLength {
                field: DetailField::Composer,
                len: 1_025
            })
        );
        let full = "a".repeat(1_024);
        assert!(SongDetails::new("t".to_owned(), full.clone(), full, VocalRole::Male).is_ok());
    }

    #[test]
    fn song_details_fields_are_utf8_without_nul_and_nothing_follows() {
        assert_eq!(
            read_details(&encoded_details(b"M\xC6", b"", b"")),
            Err(SongFileError::FieldInvalidUtf8 {
                field: DetailField::Title,
                offset: 1
            })
        );
        assert_eq!(
            read_details(&encoded_details(b"t", b"a\0b", b"")),
            Err(SongFileError::FieldNul {
                field: DetailField::Artist,
                offset: 1
            })
        );
        let mut trailing = encoded_details(b"t", b"", b"");
        trailing.push(b'x');
        assert_eq!(
            read_details(&trailing),
            Err(SongFileError::DetailsTrailingBytes { count: 1 })
        );
        let mut truncated = encoded_details(b"title", b"", b"");
        truncated.truncate(9);
        assert_eq!(
            read_details(&truncated),
            Err(SongFileError::DetailsTruncated {
                field: DetailField::Composer
            })
        );
    }

    #[test]
    fn song_details_end_with_a_known_vocal_role() {
        for (code, role) in [(1, VocalRole::Male), (2, VocalRole::Female)] {
            let mut bytes = encoded_details(b"t", b"", b"");
            *bytes.last_mut().expect("a role byte") = code;
            let Ok(Chunk::SongDetails(details)) = read_details(&bytes) else {
                panic!("role {code} is accepted");
            };
            assert_eq!(details.vocal_role(), role);
        }
        for code in [0, 3] {
            let mut bytes = encoded_details(b"t", b"", b"");
            *bytes.last_mut().expect("a role byte") = code;
            assert_eq!(
                read_details(&bytes),
                Err(SongFileError::UnknownVocalRole { value: code })
            );
        }
        let mut no_role = encoded_details(b"title", b"", b"");
        no_role.pop();
        assert_eq!(no_role.len(), 11);
        assert_eq!(
            read_details(&no_role),
            Err(SongFileError::DetailsTruncated {
                field: DetailField::VocalRole
            })
        );
    }

    #[test]
    fn thumbnail_is_0_or_1_of_1_to_1_mib() {
        assert_eq!(
            check(&with_length(ChunkType::Thumbnail, MAX_THUMBNAIL_BYTES + 1)),
            Err(chunk_length_error(
                ChunkType::Thumbnail,
                MAX_THUMBNAIL_BYTES + 1
            ))
        );
        assert_eq!(
            check(&with_length(ChunkType::Thumbnail, 0)),
            Err(chunk_length_error(ChunkType::Thumbnail, 0))
        );
        assert!(check(&with_length(ChunkType::Thumbnail, MAX_THUMBNAIL_BYTES)).is_ok());

        let mut two = with_length(ChunkType::Thumbnail, 1);
        two.insert(1, (ChunkType::Thumbnail, 1, 0));
        assert_eq!(
            check(&two),
            Err(SongFileError::ChunkOrder {
                position: 2,
                chunk_type: 2
            })
        );
    }

    #[test]
    fn lyrics_chunk_is_1_to_1_mib() {
        assert_eq!(
            check(&with_length(ChunkType::Lyrics, MAX_LYRICS_BYTES + 1)),
            Err(chunk_length_error(ChunkType::Lyrics, MAX_LYRICS_BYTES + 1))
        );
        assert_eq!(
            check(&with_length(ChunkType::Lyrics, 0)),
            Err(chunk_length_error(ChunkType::Lyrics, 0))
        );
        assert!(check(&with_length(ChunkType::Lyrics, MAX_LYRICS_BYTES)).is_ok());

        let over = vec![b'a'; MAX_LYRICS_BYTES + 1];
        assert_eq!(
            read_chunk(&entry(ChunkType::Lyrics, over.len()), &over),
            Err(chunk_length_error(ChunkType::Lyrics, MAX_LYRICS_BYTES + 1))
        );
        let full = &over[..MAX_LYRICS_BYTES];
        assert!(read_chunk(&entry(ChunkType::Lyrics, full.len()), full).is_ok());
    }

    #[test]
    fn lyrics_chunk_needs_a_word_with_letters() {
        assert_eq!(
            read_chunk(&entry(ChunkType::Lyrics, 6), b"123 !!"),
            Err(SongFileError::Lyrics(LyricsError::NoLetters))
        );
    }

    #[test]
    fn timing_chunk_is_4_plus_8_per_syllable_up_to_524292_bytes() {
        assert_eq!(
            check(&with_length(ChunkType::Timing, MAX_TIMING_BYTES + 8)),
            Err(chunk_length_error(ChunkType::Timing, MAX_TIMING_BYTES + 8))
        );
        assert_eq!(
            check(&with_length(ChunkType::Timing, 4)),
            Err(chunk_length_error(ChunkType::Timing, 4))
        );
        assert_eq!(
            check(&with_length(ChunkType::Timing, 21)),
            Err(chunk_length_error(ChunkType::Timing, 21))
        );
        assert!(check(&with_length(ChunkType::Timing, MAX_TIMING_BYTES)).is_ok());
        assert!(check(&with_length(ChunkType::Timing, MIN_TIMING_BYTES)).is_ok());

        let mut wrong_count = 3u32.to_le_bytes().to_vec();
        wrong_count.resize(20, 0);
        assert_eq!(
            read_chunk(&entry(ChunkType::Timing, 20), &wrong_count),
            Err(SongFileError::TimingLength { len: 20, count: 3 })
        );
    }

    #[test]
    fn syllable_count_is_1_to_65536() {
        let times = |count: u32| -> Vec<SyllableTime> {
            (0..count)
                .map(|i| SyllableTime {
                    start_ms: i,
                    end_ms: i + 1,
                })
                .collect()
        };
        assert_eq!(
            Timing::new(times(65_537)),
            Err(SongFileError::SyllableCount { count: 65_537 })
        );
        assert_eq!(
            Timing::new(Vec::new()),
            Err(SongFileError::SyllableCount { count: 0 })
        );
        assert!(Timing::new(times(65_536)).is_ok());

        let mut over = 65_537u32.to_le_bytes().to_vec();
        for time in times(65_537) {
            over.extend_from_slice(&time.start_ms.to_le_bytes());
            over.extend_from_slice(&time.end_ms.to_le_bytes());
        }
        assert_eq!(
            read_chunk(&entry(ChunkType::Timing, over.len()), &over),
            Err(chunk_length_error(ChunkType::Timing, over.len()))
        );
        let mut zero = 0u32.to_le_bytes().to_vec();
        zero.resize(12, 0);
        assert_eq!(
            read_chunk(&entry(ChunkType::Timing, 12), &zero),
            Err(SongFileError::TimingLength { len: 12, count: 0 })
        );
    }

    #[test]
    fn syllables_start_before_they_end_and_do_not_overlap() {
        let times = |pairs: &[(u32, u32)]| {
            pairs
                .iter()
                .map(|&(start_ms, end_ms)| SyllableTime { start_ms, end_ms })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            Timing::new(times(&[(0, 10), (10, 10)])),
            Err(SongFileError::SyllableOrder { index: 1 })
        );
        assert_eq!(
            Timing::new(times(&[(0, 10), (20, 15)])),
            Err(SongFileError::SyllableOrder { index: 1 })
        );
        assert_eq!(
            Timing::new(times(&[(0, 10), (9, 20)])),
            Err(SongFileError::SyllableOverlap { index: 1 })
        );
        assert!(Timing::new(times(&[(0, 10), (10, 20), (25, 30)])).is_ok());
    }

    #[test]
    fn timing_matches_the_lyrics_and_ends_by_the_end_of_the_song() {
        let lyrics = lyrics("Mưa rơi\n");
        assert_eq!(
            check_timing(&timing(&[(0, 500)]), &lyrics, 1000),
            Err(SongFileError::SyllableMismatch {
                count: 1,
                expected: 2
            })
        );
        assert_eq!(
            check_timing(&timing(&[(0, 500), (500, 1001)]), &lyrics, 1000),
            Err(SongFileError::TimingPastEnd {
                end_ms: 1001,
                song_ms: 1000
            })
        );
        assert_eq!(
            check_timing(&timing(&[(0, 500), (500, 1000)]), &lyrics, 1000),
            Ok(())
        );
    }

    #[test]
    fn init_segment_chunk_is_1_to_65536_bytes() {
        for chunk_type in [ChunkType::KaraokeInit, ChunkType::OriginalInit] {
            assert_eq!(
                check(&with_length(chunk_type, MAX_INIT_BYTES + 1)),
                Err(chunk_length_error(chunk_type, MAX_INIT_BYTES + 1))
            );
            assert_eq!(
                check(&with_length(chunk_type, 0)),
                Err(chunk_length_error(chunk_type, 0))
            );
            assert!(check(&with_length(chunk_type, MAX_INIT_BYTES)).is_ok());
        }
        let mut video = parts(Some(&[(1, 1000)]), &[(2, 1000)], &[(2, 1000)]);
        video[3].1 = MAX_INIT_BYTES + 1;
        assert_eq!(
            check(&video),
            Err(chunk_length_error(ChunkType::VideoInit, MAX_INIT_BYTES + 1))
        );
    }

    #[test]
    fn media_segment_chunk_is_1_to_16_mib() {
        assert_eq!(
            check(&parts(None, &[(MAX_SEGMENT_BYTES + 1, 1000)], &[(2, 1000)])),
            Err(chunk_length_error(
                ChunkType::KaraokeSegment,
                MAX_SEGMENT_BYTES + 1
            ))
        );
        assert_eq!(
            check(&parts(None, &[(2, 1000)], &[(0, 1000)])),
            Err(chunk_length_error(ChunkType::OriginalSegment, 0))
        );
        assert_eq!(
            check(&parts(
                Some(&[(MAX_SEGMENT_BYTES + 1, 1000)]),
                &[(2, 1000)],
                &[(2, 1000)]
            )),
            Err(chunk_length_error(
                ChunkType::VideoSegment,
                MAX_SEGMENT_BYTES + 1
            ))
        );
        assert!(check(&parts(None, &[(MAX_SEGMENT_BYTES, 1000)], &[(2, 1000)])).is_ok());
    }

    #[test]
    fn media_segment_lasts_1_to_10000_ms() {
        assert_eq!(
            check(&parts(None, &[(2, 10_001)], &[(2, 10_001)])),
            Err(SongFileError::SegmentDuration {
                position: 4,
                duration_ms: 10_001
            })
        );
        assert_eq!(
            check(&parts(None, &[(2, 1000), (2, 0)], &[(2, 1000), (2, 0)])),
            Err(SongFileError::SegmentDuration {
                position: 5,
                duration_ms: 0
            })
        );
        assert_eq!(
            check(&parts(Some(&[(2, 10_001)]), &[(2, 10_000)], &[(2, 10_000)])),
            Err(SongFileError::SegmentDuration {
                position: 4,
                duration_ms: 10_001
            })
        );
        assert_eq!(
            check(&parts(None, &[(2, 10_000)], &[(2, 10_000)])),
            Ok(10_000)
        );
    }

    #[test]
    fn a_track_has_1_to_4096_segments() {
        let over = vec![(1, 1); MAX_SEGMENTS + 1];
        let full = vec![(1, 1); MAX_SEGMENTS];
        assert_eq!(
            check(&parts(None, &over, &over)),
            Err(SongFileError::SegmentCount {
                chunk_type: 19,
                count: 4_097
            })
        );
        assert_eq!(
            check(&parts(None, &full, &over)),
            Err(SongFileError::SegmentCount {
                chunk_type: 21,
                count: 4_097
            })
        );
        assert_eq!(
            check(&parts(Some(&over), &full, &full)),
            Err(SongFileError::SegmentCount {
                chunk_type: 17,
                count: 4_097
            })
        );
        assert_eq!(check(&parts(Some(&full), &full, &full)), Ok(4_096));
        assert_eq!(
            check(&parts(None, &[], &[(2, 500), (2, 500)])),
            Err(SongFileError::SegmentCount {
                chunk_type: 19,
                count: 0
            })
        );
        assert_eq!(
            check(&parts(Some(&[]), &[(2, 1000)], &[(2, 1000)])),
            Err(SongFileError::SegmentCount {
                chunk_type: 17,
                count: 0
            })
        );
    }

    #[test]
    fn song_lasts_at_most_one_hour() {
        let mut over = vec![(1, MAX_SEGMENT_MS); 360];
        over.push((1, 1));
        assert_eq!(
            check(&parts(None, &over, &over)),
            Err(SongFileError::SongDuration {
                duration_ms: 3_600_001
            })
        );
        over.pop();
        assert_eq!(check(&parts(None, &over, &over)), Ok(MAX_SONG_MS));
    }

    #[test]
    fn video_lasts_within_1000_ms_of_the_song() {
        let song = [(2, 5000)];
        for video_ms in [3_999, 6_001] {
            assert_eq!(
                check(&parts(Some(&[(2, video_ms)]), &song, &song)),
                Err(SongFileError::VideoDuration {
                    video_ms: u64::from(video_ms),
                    song_ms: 5000
                })
            );
        }
        for video_ms in [4_000, 6_000] {
            assert_eq!(
                check(&parts(Some(&[(2, video_ms)]), &song, &song)),
                Ok(5000)
            );
        }
    }

    #[test]
    fn both_tracks_are_cut_at_the_same_times() {
        assert_eq!(
            check(&parts(None, &[(2, 500), (2, 500)], &[(2, 1000)])),
            Err(SongFileError::TrackLengths {
                karaoke: 2,
                original: 1
            })
        );
        assert_eq!(
            check(&parts(None, &[(2, 500), (2, 500)], &[(2, 400), (2, 600)])),
            Err(SongFileError::SegmentMismatch { position: 7 })
        );
        // Video segments may be cut at other times than the audio.
        assert_eq!(
            check(&parts(
                Some(&[(2, 300), (2, 900)]),
                &[(2, 500), (2, 500)],
                &[(2, 500), (2, 500)]
            )),
            Ok(1000)
        );
    }

    #[test]
    fn rejects_chunk_bytes_of_the_wrong_length() {
        assert_eq!(
            read_chunk(&entry(ChunkType::KaraokeSegment, 3), b"ks"),
            Err(SongFileError::ChunkBytes {
                chunk_type: 19,
                len: 2,
                expected: 3
            })
        );
    }

    #[test]
    fn writer_refuses_songs_the_reader_would_reject() {
        let mut wrong_count = example_song();
        wrong_count.timing = timing(&[(0, 500)]);
        assert_eq!(
            write(&wrong_count),
            Err(SongFileError::SyllableMismatch {
                count: 1,
                expected: 2
            })
        );

        let mut past_end = example_song();
        past_end.timing = timing(&[(0, 500), (500, 1001)]);
        assert_eq!(
            write(&past_end),
            Err(SongFileError::TimingPastEnd {
                end_ms: 1001,
                song_ms: 1000
            })
        );

        let mut no_video_segments = example_song();
        no_video_segments.video = Some(track(b"vi", &[]));
        assert_eq!(
            write(&no_video_segments),
            Err(SongFileError::SegmentCount {
                chunk_type: 17,
                count: 0
            })
        );

        let mut empty_init = example_song();
        empty_init.karaoke.init.clear();
        assert_eq!(
            write(&empty_init),
            Err(chunk_length_error(ChunkType::KaraokeInit, 0))
        );

        let mut original_differs = example_song();
        original_differs.original.segments[0].duration_ms = 999;
        assert!(matches!(
            write(&original_differs),
            Err(SongFileError::SegmentMismatch { .. })
        ));
    }

    #[test]
    fn error_messages_do_not_echo_song_details_or_lyrics() {
        let word = "Xuânthì";
        let too_long = word.repeat(200);
        let errors = [
            SongDetails::new(
                format!("{word}\0"),
                String::new(),
                String::new(),
                VocalRole::Male,
            )
            .unwrap_err(),
            SongDetails::new(
                too_long.clone(),
                String::new(),
                String::new(),
                VocalRole::Male,
            )
            .unwrap_err(),
            SongDetails::new("t".to_owned(), too_long, String::new(), VocalRole::Male).unwrap_err(),
            read_details(&encoded_details(
                b"t",
                b"",
                &[word.as_bytes(), b"\xC6"].concat(),
            ))
            .unwrap_err(),
            read_chunk(&entry(ChunkType::Lyrics, 9), b"#4271!! 9").unwrap_err(),
        ];
        for err in &errors {
            let message = err.to_string();
            assert!(!message.contains(word), "{message}");
            assert!(!message.contains("#4271"), "{message}");
        }
    }

    #[test]
    fn error_messages_state_the_rule() {
        assert_eq!(
            SongFileError::FileSize {
                size: 247,
                end: 248
            }
            .to_string(),
            "last chunk ends at byte 248, but the file is 247 bytes"
        );
        assert_eq!(
            SongFileError::FieldLength {
                field: DetailField::Title,
                len: 1_025
            }
            .to_string(),
            "title is 1025 bytes, outside the limits for the title"
        );
        assert_eq!(
            SongFileError::UnknownVocalRole { value: 3 }.to_string(),
            "vocal role 3 is not known"
        );
        assert_eq!(
            SongFileError::Lyrics(LyricsError::NoLetters).to_string(),
            "lyrics chunk rejected: lyrics contain no word with letters"
        );
    }
}
