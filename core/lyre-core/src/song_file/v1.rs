//! Song files, format version 1: the encrypted, authenticated `.lyre` file.
//!
//! The byte layout, the keys and the rules are in
//! `docs/reference/song-file-format-v1.md`. Version 1 lives next to version 0
//! and reuses its chunk rules, limits and parsers. Only the framing differs: a
//! 177-byte header that holds the recovery wrap, a 16-byte tag after the
//! index, and a 16-byte tag on every chunk.
//!
//! Reading follows the reading model of the format doc, in steps that need no
//! more than the bytes of each step: [`Header::parse`] reads the header
//! without a key, [`Index::open`] checks the header and index tag under the
//! content key and then every index rule, and [`Index::read_chunk`] decrypts
//! and parses one chunk when asked. [`read`] does all three on a file held in
//! memory. A changed chunk is refused when that chunk is read.
//!
//! The writer takes the content key as an opaque handle. No error message
//! quotes a key, the lyrics or the song details, and the header and index tag
//! failure does not say which part failed.

use std::fmt;

use aes_gcm::aead::AeadInPlace;
use aes_gcm::aead::consts::U12;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Tag};
use hkdf::Hkdf;
use rand_core::{CryptoRng, OsRng, RngCore};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::{
    Chunk, Framing, INDEX_ENTRY_LEN, IndexEntry, MAGIC, Next, Song, SongFileError, SongPlan,
    assemble, chunk_bytes, decode_entry, encode_index, parse_header_start, plan_song,
    validate_framed,
};
use crate::content_key::{ContentKey, KEY_LEN};
use crate::recovery::{ENC_LEN, RecoveryPublicKey, RecoveryWrap, SEALED_LEN};

/// The format version this module reads and writes.
pub const VERSION: u16 = 1;
/// The size of the header, in bytes.
pub const HEADER_LEN: usize = 177;
/// The size of an AES-256-GCM tag: the header and index tag, and the tag of
/// each chunk.
pub const TAG_LEN: usize = 16;
/// The size of the salt, in bytes.
pub const SALT_LEN: usize = 32;

/// Version 1: a 177-byte header, a tag after the index and a tag on every
/// chunk.
const V1: Framing = Framing {
    header_len: HEADER_LEN as u64,
    index_tag_len: TAG_LEN as u64,
    chunk_tag_len: TAG_LEN as u32,
};

/// Where the fields of the header start.
const SALT_AT: usize = 32;
const ENC_AT: usize = SALT_AT + SALT_LEN;
const SEALED_AT: usize = ENC_AT + ENC_LEN;

/// The HKDF `info` of the header key and of the chunk key.
const HEADER_KEY_INFO: &[u8] = b"lyre/v1/song-file/header";
const CHUNK_KEY_INFO: &[u8] = b"lyre/v1/song-file/chunk";

/// An AES-GCM nonce: 12 bytes.
type Nonce = aes_gcm::Nonce<U12>;

/// The size of the chunk's associated data, in bytes.
const CHUNK_AAD_LEN: usize = 2 + 16 + 4 + 4 + INDEX_ENTRY_LEN;

/// The fresh random salt of one write. It makes the keys of the write unique.
/// A salt cannot be copied, and outside tests the only way to make one is
/// from the system's random source, so a write cannot reuse one.
///
/// ```compile_fail
/// let salt = lyre_core::song_file::v1::Salt::generate();
/// let _ = salt.clone();
/// ```
pub struct Salt([u8; SALT_LEN]);

impl fmt::Debug for Salt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Salt {{ .. }}")
    }
}

impl Salt {
    /// Makes a salt from fresh random bytes from the operating system, or
    /// from the browser on WebAssembly.
    pub fn generate() -> Salt {
        let mut bytes = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut bytes);
        Salt(bytes)
    }

    /// Makes a salt from the given bytes, for known-answer vectors.
    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; SALT_LEN]) -> Salt {
        Salt(bytes)
    }
}

/// The chunk key of one write. It wipes its bytes when dropped, and its
/// `Debug` text shows nothing of them.
struct ChunkKey(Zeroizing<[u8; KEY_LEN]>);

impl fmt::Debug for ChunkKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ChunkKey {{ .. }}")
    }
}

/// The two keys of one write, derived from the content key and the salt.
/// It has no `Debug`.
struct Keys {
    header: Zeroizing<[u8; KEY_LEN]>,
    chunk: ChunkKey,
}

impl Keys {
    fn derive(salt: &[u8; SALT_LEN], content_key: &ContentKey) -> Keys {
        let hkdf = Hkdf::<Sha256>::new(Some(salt), content_key.expose());
        let expand = |info: &[u8]| {
            let mut key = Zeroizing::new([0u8; KEY_LEN]);
            hkdf.expand(info, key.as_mut_slice())
                .expect("32 bytes are far below HKDF's output limit");
            key
        };
        Keys {
            header: expand(HEADER_KEY_INFO),
            chunk: ChunkKey(expand(CHUNK_KEY_INFO)),
        }
    }
}

fn cipher(key: &[u8; KEY_LEN]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

/// The one tag that authenticates the header and the index together:
/// AES-256-GCM with the header key, a zero nonce, empty plaintext and the
/// header and index bytes as associated data.
fn header_tag(key: &[u8; KEY_LEN], header: &[u8], index: &[u8]) -> [u8; TAG_LEN] {
    let tag = cipher(key)
        .encrypt_in_place_detached(&Nonce::from([0u8; 12]), &header_aad(header, index), &mut [])
        .expect("an empty plaintext is far below AES-GCM's size limit");
    tag.into()
}

/// Checks the header and index tag. Every failure gives the same error.
fn check_header_tag(
    key: &[u8; KEY_LEN],
    header: &[u8],
    index: &[u8],
    tag: &[u8],
) -> Result<(), SongFileError> {
    let tag = <[u8; TAG_LEN]>::try_from(tag).map_err(|_| SongFileError::HeaderTag)?;
    cipher(key)
        .decrypt_in_place_detached(
            &Nonce::from([0u8; 12]),
            &header_aad(header, index),
            &mut [],
            &Tag::from(tag),
        )
        .map_err(|_| SongFileError::HeaderTag)
}

/// The header bytes followed by the index bytes.
fn header_aad(header: &[u8], index: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(header.len() + index.len());
    aad.extend_from_slice(header);
    aad.extend_from_slice(index);
    aad
}

impl ChunkKey {
    /// The nonce of the chunk at `position`: the position as a u64, then four
    /// zero bytes.
    fn nonce(position: u32) -> Nonce {
        let mut nonce = [0u8; 12];
        nonce[..8].copy_from_slice(&u64::from(position).to_le_bytes());
        Nonce::from(nonce)
    }

    /// The 50 bytes of associated data that bind a chunk to its file and its
    /// place: the version, the song ID, the entry count, the position and the
    /// chunk's index entry as stored.
    fn aad(
        song_id: &[u8; 16],
        entry_count: u32,
        position: u32,
        entry: &[u8],
    ) -> [u8; CHUNK_AAD_LEN] {
        let mut aad = [0u8; CHUNK_AAD_LEN];
        aad[0..2].copy_from_slice(&VERSION.to_le_bytes());
        aad[2..18].copy_from_slice(song_id);
        aad[18..22].copy_from_slice(&entry_count.to_le_bytes());
        aad[22..26].copy_from_slice(&position.to_le_bytes());
        aad[26..].copy_from_slice(entry);
        aad
    }

    /// Encrypts `chunk` in place and appends its tag.
    fn seal(&self, aad: &[u8], position: u32, mut chunk: Vec<u8>) -> Vec<u8> {
        chunk.reserve_exact(TAG_LEN);
        cipher(&self.0)
            .encrypt_in_place(&ChunkKey::nonce(position), aad, &mut chunk)
            .expect("a chunk is far below AES-GCM's size limit");
        chunk
    }

    /// Authenticates and decrypts `stored`, a chunk followed by its tag. A
    /// failure drops the bytes and returns no plaintext.
    fn open(
        &self,
        aad: &[u8],
        position: u32,
        mut stored: Vec<u8>,
    ) -> Result<Vec<u8>, SongFileError> {
        cipher(&self.0)
            .decrypt_in_place(&ChunkKey::nonce(position), aad, &mut stored)
            .map_err(|_| SongFileError::ChunkTag {
                position: position as usize,
            })?;
        Ok(stored)
    }
}

/// The parsed header of a version 1 song file. Parsing checks only the
/// structure. Nothing is authenticated until [`Index::open`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    raw: [u8; HEADER_LEN],
    song_id: [u8; 16],
    entry_count: u32,
}

impl Header {
    /// Parses the first 177 bytes of `bytes`. Bytes after them are ignored.
    /// Version 0, and any version other than 1, is refused.
    pub fn parse(bytes: &[u8]) -> Result<Header, SongFileError> {
        let (entry_count, song_id) = parse_header_start(bytes, VERSION, HEADER_LEN)?;
        let raw =
            bytes
                .first_chunk::<HEADER_LEN>()
                .copied()
                .ok_or(SongFileError::HeaderTooShort {
                    len: bytes.len(),
                    needed: HEADER_LEN,
                })?;
        Ok(Header {
            raw,
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

    /// The length of the index that follows the header, in bytes. The header
    /// and index tag comes after it.
    pub fn index_len(&self) -> usize {
        // `entry_count` is at most MAX_ENTRY_COUNT, so this cannot overflow.
        usize::try_from(self.entry_count).map_or(usize::MAX, |count| count * INDEX_ENTRY_LEN)
    }

    /// The recovery wrap: the two header fields that hold the sealed content
    /// key.
    pub fn recovery_wrap(&self) -> RecoveryWrap {
        let mut enc = [0u8; ENC_LEN];
        enc.copy_from_slice(&self.raw[ENC_AT..SEALED_AT]);
        let mut sealed = [0u8; SEALED_LEN];
        sealed.copy_from_slice(&self.raw[SEALED_AT..]);
        RecoveryWrap { enc, sealed }
    }

    fn salt(&self) -> &[u8; SALT_LEN] {
        self.raw[SALT_AT..ENC_AT]
            .try_into()
            .expect("the salt is 32 bytes")
    }
}

/// An index whose header and index tag passed under the content key, and
/// whose every structural rule holds. It holds the chunk key and decrypts a
/// chunk only when asked.
#[derive(Debug)]
pub struct Index {
    song_id: [u8; 16],
    entry_count: u32,
    /// The index bytes as stored, for the chunks' associated data.
    raw: Vec<u8>,
    /// The entries as stored: each length includes the chunk's tag.
    entries: Vec<IndexEntry>,
    duration_ms: u32,
    chunk_key: ChunkKey,
}

impl Index {
    /// Checks the tag in `index_and_tag`, the index and the 16-byte tag after
    /// it, against `header` and the content key. Only when it passes does it
    /// read the index and check every index rule against the total
    /// `file_size`.
    pub fn open(
        header: &Header,
        content_key: &ContentKey,
        index_and_tag: &[u8],
        file_size: u64,
    ) -> Result<Index, SongFileError> {
        let expected = header.index_len() + TAG_LEN;
        if index_and_tag.len() != expected {
            return Err(SongFileError::IndexLength {
                len: index_and_tag.len(),
                expected,
            });
        }
        let (raw, tag) = index_and_tag.split_at(header.index_len());
        let keys = Keys::derive(header.salt(), content_key);
        check_header_tag(&keys.header, &header.raw, raw, tag)?;

        let entries = raw
            .as_chunks::<INDEX_ENTRY_LEN>()
            .0
            .iter()
            .enumerate()
            .map(|(position, entry)| decode_entry(position, entry))
            .collect::<Result<Vec<_>, _>>()?;
        let duration_ms = validate_framed(&entries, file_size, V1)?;
        Ok(Index {
            song_id: header.song_id,
            entry_count: header.entry_count,
            raw: raw.to_vec(),
            entries,
            duration_ms,
            chunk_key: keys.chunk,
        })
    }

    /// The entries, in the order the chunks are stored. Each length includes
    /// the chunk's 16-byte tag.
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    /// The song's duration: the karaoke track's end, its last segment's
    /// start plus its duration.
    pub fn duration_ms(&self) -> u32 {
        self.duration_ms
    }

    /// Decrypts and parses the chunk at `position`. `stored` must be exactly
    /// the chunk's stored bytes: its ciphertext and its tag. A chunk that
    /// does not authenticate is refused with its position, and none of its
    /// bytes are returned.
    pub fn read_chunk(&self, position: usize, stored: &[u8]) -> Result<Chunk, SongFileError> {
        let entry = self
            .entries
            .get(position)
            .ok_or(SongFileError::NoEntry { position })?;
        if usize::try_from(entry.length) != Ok(stored.len()) {
            return Err(SongFileError::ChunkBytes {
                chunk_type: entry.chunk_type.code(),
                len: stored.len(),
                expected: entry.length,
            });
        }
        let position_u32 =
            u32::try_from(position).map_err(|_| SongFileError::NoEntry { position })?;
        let raw_entry = &self.raw[position * INDEX_ENTRY_LEN..][..INDEX_ENTRY_LEN];
        let aad = ChunkKey::aad(&self.song_id, self.entry_count, position_u32, raw_entry);
        let plain = self.chunk_key.open(&aad, position_u32, stored.to_vec())?;
        let plain_entry = IndexEntry {
            length: entry.length - V1.chunk_tag_len,
            ..entry.clone()
        };
        super::read_chunk(&plain_entry, &plain)
    }
}

/// Reads a whole version 1 song file held in memory, with the song's content
/// key.
pub fn read(file: &[u8], content_key: &ContentKey) -> Result<Song, SongFileError> {
    let header = Header::parse(file)?;
    let expected = header.index_len() + TAG_LEN;
    let index_and_tag =
        file.get(HEADER_LEN..HEADER_LEN + expected)
            .ok_or(SongFileError::IndexLength {
                len: file.len().saturating_sub(HEADER_LEN),
                expected,
            })?;
    let index = Index::open(&header, content_key, index_and_tag, file.len() as u64)?;
    assemble(
        header.song_id(),
        index.entries(),
        index.duration_ms(),
        |position, entry| {
            let stored = chunk_bytes(file, entry).ok_or(SongFileError::FileSize {
                size: file.len() as u64,
                end: entry.offset.saturating_add(u64::from(entry.length)),
            })?;
            index.read_chunk(position, stored)
        },
    )
}

/// Gives out a version 1 song file piece by piece, every chunk encrypted:
/// [`head`](PieceWriter::head) first, then each chunk in file order. The
/// writer makes every chunk but the media segments. It takes those one at a
/// time from the caller and hands each back encrypted, so no more than one
/// segment is held.
///
/// [`PieceWriter::new`] runs every check that the reader runs, on the whole
/// plan, before any piece is given out.
pub struct PieceWriter {
    inner: super::PieceWriter,
    head: Vec<u8>,
    chunk_key: ChunkKey,
    song_id: [u8; 16],
    entry_count: u32,
    /// The index bytes as stored, for the chunks' associated data.
    index: Vec<u8>,
}

impl fmt::Debug for PieceWriter {
    /// Shows only how far the writer is. The chunks hold the lyrics.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PieceWriter")
            .field("entry_count", &self.entry_count)
            .field("file_size", &self.inner.file_size())
            .finish_non_exhaustive()
    }
}

impl PieceWriter {
    /// Plans the song file, checks it as the reader would and seals the
    /// content key to the recovery public key. A plan that the reader would
    /// reject is refused before any piece is given out.
    ///
    /// The `salt` is used up. Make a fresh one for every write.
    pub fn new(
        plan: SongPlan,
        content_key: &ContentKey,
        recovery: &RecoveryPublicKey,
        salt: Salt,
    ) -> Result<PieceWriter, SongFileError> {
        PieceWriter::new_with_rng(plan, content_key, recovery, salt, &mut OsRng)
    }

    /// [`PieceWriter::new`] with the given random source for the recovery
    /// wrap. Only tests and the vectors fix it.
    pub(crate) fn new_with_rng(
        plan: SongPlan,
        content_key: &ContentKey,
        recovery: &RecoveryPublicKey,
        salt: Salt,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<PieceWriter, SongFileError> {
        let inner = super::PieceWriter::plan(&plan, V1)?;
        let wrap = RecoveryWrap::seal_with_rng(content_key, recovery, &plan.song_id, rng);
        let entry_count =
            u32::try_from(inner.entries.len()).map_err(|_| SongFileError::EntryCount {
                count: inner.entries.len() as u64,
            })?;
        let index = encode_index(&inner.entries);

        let mut head = Vec::with_capacity(HEADER_LEN + index.len() + TAG_LEN);
        head.extend_from_slice(&MAGIC);
        head.extend_from_slice(&VERSION.to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(&entry_count.to_le_bytes());
        head.extend_from_slice(&plan.song_id);
        head.extend_from_slice(&salt.0);
        head.extend_from_slice(&wrap.enc);
        head.extend_from_slice(&wrap.sealed);
        debug_assert_eq!(head.len(), HEADER_LEN);

        let keys = Keys::derive(&salt.0, content_key);
        let tag = header_tag(&keys.header, &head, &index);
        head.extend_from_slice(&index);
        head.extend_from_slice(&tag);
        Ok(PieceWriter {
            inner,
            head,
            chunk_key: keys.chunk,
            song_id: plan.song_id,
            entry_count,
            index,
        })
    }

    /// The header, the index and the header and index tag: the first piece of
    /// the file.
    pub fn head(&self) -> &[u8] {
        &self.head
    }

    /// The size of the whole file, in bytes.
    pub fn file_size(&self) -> u64 {
        self.inner.file_size()
    }

    /// The next chunk to give out, encrypted. A chunk the writer makes is
    /// given out and the writer moves on. For a media segment the writer
    /// stays until [`PieceWriter::segment`] takes its bytes.
    pub fn next_chunk(&mut self) -> Next {
        let position = self.inner.position;
        match self.inner.next_chunk() {
            Next::Chunk(chunk) => Next::Chunk(self.seal(position, chunk)),
            other => other,
        }
    }

    /// Takes the bytes of the media segment that [`PieceWriter::next_chunk`]
    /// named, checks their length against the plan, and hands them back
    /// encrypted, with their tag, to write.
    pub fn segment(&mut self, bytes: Vec<u8>) -> Result<Vec<u8>, SongFileError> {
        let position = self.inner.position;
        self.inner.take_segment(bytes.len())?;
        Ok(self.seal(position, bytes))
    }

    /// Encrypts the chunk at `position`.
    fn seal(&self, position: usize, chunk: Vec<u8>) -> Vec<u8> {
        // The writer has checked the entry count against the limits, so a
        // position fits.
        let position = u32::try_from(position).expect("a position is below 16,385");
        let entry = &self.index[position as usize * INDEX_ENTRY_LEN..][..INDEX_ENTRY_LEN];
        let aad = ChunkKey::aad(&self.song_id, self.entry_count, position, entry);
        self.chunk_key.seal(&aad, position, chunk)
    }
}

/// Writes `song` as a version 1 song file, with a fresh `salt`. A song that
/// the reader would reject is refused before any file bytes are written.
pub fn write(
    song: &Song,
    content_key: &ContentKey,
    recovery: &RecoveryPublicKey,
    salt: Salt,
) -> Result<Vec<u8>, SongFileError> {
    write_with_rng(song, content_key, recovery, salt, &mut OsRng)
}

/// [`write`] with the given random source for the recovery wrap.
pub(crate) fn write_with_rng(
    song: &Song,
    content_key: &ContentKey,
    recovery: &RecoveryPublicKey,
    salt: Salt,
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<Vec<u8>, SongFileError> {
    let mut writer = PieceWriter::new_with_rng(plan_song(song)?, content_key, recovery, salt, rng)?;
    let capacity =
        usize::try_from(writer.file_size()).map_err(|_| SongFileError::FileTooLarge {
            size: writer.file_size(),
        })?;
    let mut file = Vec::with_capacity(capacity);
    file.extend_from_slice(writer.head());
    let mut segments = super::Segments::new(song);
    loop {
        match writer.next_chunk() {
            Next::Chunk(bytes) => file.extend_from_slice(&bytes),
            Next::Segment(chunk_type) => {
                let bytes = segments.next(chunk_type).to_vec();
                file.extend_from_slice(&writer.segment(bytes)?);
            }
            Next::End => return Ok(file),
        }
    }
}

#[cfg(test)]
mod tests {
    use sha2::Digest;

    use super::*;
    use crate::recovery::{FixedIkm, RecoveryKey, hex, table, unhex};
    use crate::song_file::tests::{
        AAC_TYPE, details, example, example_song, hex_dump, lyrics, timing, track, with_length,
    };
    use crate::song_file::{ChunkType, KARAOKE_TYPE, VocalRole, layout_framed, plan_song};

    const FORMAT_DOC: &str = include_str!("../../../../docs/reference/song-file-format-v1.md");

    /// The value of the recovery wrap vector's row named `item`.
    fn vector(item: &str) -> String {
        table(FORMAT_DOC, "### Recovery wrap vector")
            .into_iter()
            .find(|row| row[0] == item)
            .unwrap_or_else(|| panic!("the vector has a row {item}"))[1]
            .clone()
    }

    /// The text block that follows `marker` in the format doc.
    fn text_block(marker: &str) -> String {
        let (_, after) = FORMAT_DOC
            .split_once(marker)
            .expect("the doc has the marker");
        let (_, block) = after.split_once("```text\n").expect("a text block");
        let (text, _) = block.split_once("```").expect("the block ends");
        text.trim().to_owned()
    }

    fn recovery_key() -> RecoveryKey {
        let seed: [u8; 32] = unhex(&vector("Recovery seed"))
            .try_into()
            .expect("32 bytes");
        RecoveryKey::from_seed(&seed).expect("a valid seed")
    }

    /// The content key of the known-answer example: the bytes `40` to `5F`.
    fn content_key() -> ContentKey {
        ContentKey::from_bytes(std::array::from_fn(|i| 0x40 + i as u8))
    }

    /// The salt of the known-answer example: the bytes `20` to `3F`.
    fn example_salt() -> Salt {
        Salt::from_bytes(std::array::from_fn(|i| 0x20 + i as u8))
    }

    fn example_ikm() -> FixedIkm {
        let ikm: [u8; 32] = unhex(&vector("Ephemeral input (`ikmE`)"))
            .try_into()
            .expect("32 bytes");
        FixedIkm(ikm, false)
    }

    /// The known-answer example, made from its fixed inputs.
    fn written_example() -> Vec<u8> {
        write_with_rng(
            &example_song(),
            &content_key(),
            &recovery_key().public_key(),
            example_salt(),
            &mut example_ikm(),
        )
        .expect("the example is valid")
    }

    /// The known-answer example, read from the format doc's hex dump.
    fn documented_example() -> Vec<u8> {
        hex_dump(FORMAT_DOC, 580)
    }

    /// The error of reading `file` with the example's content key.
    fn refused(file: &[u8]) -> SongFileError {
        read(file, &content_key()).expect_err("the file is refused")
    }

    #[test]
    fn writes_the_known_answer_example() {
        let file = written_example();
        assert_eq!(file, documented_example());
        assert_eq!(
            hex(&Sha256::digest(&file)),
            text_block("SHA-256 of the whole file:")
        );
    }

    #[test]
    fn the_known_answer_keys_are_the_documented_ones() {
        let keys = Keys::derive(&example_salt().0, &content_key());
        let rows = table(FORMAT_DOC, "### Derived keys");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ["header_key", hex(&*keys.header).as_str()]);
        assert_eq!(rows[1], ["chunk_key", hex(&*keys.chunk.0).as_str()]);
    }

    #[test]
    fn reads_the_known_answer_example() {
        let song = read(&documented_example(), &content_key()).expect("the example is valid");
        assert_eq!(song, example_song());
        assert_eq!(song.lyrics.as_bytes(), "Mưa rơi\n".as_bytes());
    }

    #[test]
    fn the_known_answer_header_holds_the_documented_wrap() {
        let file = documented_example();
        let header = Header::parse(&file).expect("the header is valid");
        assert_eq!(header.song_id(), example_song().song_id);
        assert_eq!(header.entry_count(), 7);
        assert_eq!(header.index_len(), 168);
        assert_eq!(header.salt(), &example_salt().0);
        let wrap = header.recovery_wrap();
        assert_eq!(hex(&wrap.enc), vector("recovery_enc"));
        assert_eq!(hex(&wrap.sealed), vector("recovery_sealed"));
        let opened = wrap
            .open(&recovery_key(), &header.song_id())
            .expect("the wrap opens");
        assert_eq!(opened.expose(), content_key().expose());
    }

    #[test]
    fn the_layout_table_matches_the_example() {
        let file = documented_example();
        let rows = table(FORMAT_DOC, "Its layout is fixed:");
        assert_eq!(rows.len(), 10);
        let mut offset = 0;
        for row in &rows {
            assert_eq!(row[0].parse::<usize>(), Ok(offset), "{row:?}");
            offset += row[1].parse::<usize>().expect("a size");
        }
        assert_eq!(offset, file.len());
        let header = Header::parse(&file).expect("the header is valid");
        let index = Index::open(&header, &content_key(), &file[177..361], 580).expect("valid");
        assert_eq!(index.entries().len(), rows.len() - 3);
        for (entry, row) in index.entries().iter().zip(&rows[3..]) {
            assert_eq!(entry.offset.to_string(), row[0], "{row:?}");
            assert_eq!(entry.length.to_string(), row[1], "{row:?}");
        }
    }

    /// The rows of the invalid variants table, as their `Change` cells.
    fn invalid_variants() -> Vec<String> {
        table(FORMAT_DOC, "### Invalid variants")
            .into_iter()
            .map(|row| row[0].clone())
            .collect()
    }

    #[test]
    fn rejects_every_invalid_variant() {
        let variants = invalid_variants();
        // One case below for each row, in the doc's order.
        assert_eq!(variants.len(), 12);
        let file = documented_example();
        let flip = |offset: usize| {
            let mut changed = file.clone();
            changed[offset] ^= 1;
            changed
        };

        // Version 0: bytes 8–9 are 00 00, and the real version-0 example.
        assert!(variants[0].starts_with("Version 0"));
        let mut version_0 = file.clone();
        version_0[8..10].copy_from_slice(&[0, 0]);
        let unsupported = SongFileError::UnsupportedVersion { version: 0 };
        assert_eq!(refused(&version_0), unsupported);
        assert_eq!(refused(&example()), unsupported);
        let mut version_2 = file.clone();
        version_2[8] = 2;
        assert_eq!(
            refused(&version_2),
            SongFileError::UnsupportedVersion { version: 2 }
        );

        // Byte 0 is changed.
        assert!(variants[1].starts_with("Byte 0"));
        assert_eq!(refused(&flip(0)), SongFileError::BadMagic);

        // A byte of the song ID, the salt or the recovery wrap, 16–176.
        assert!(variants[2].contains("16–176"));
        for offset in 16..177 {
            assert_eq!(
                refused(&flip(offset)),
                SongFileError::HeaderTag,
                "byte {offset}"
            );
        }

        // A byte of the index, 177–344.
        assert!(variants[3].contains("177–344"));
        for offset in 177..345 {
            assert_eq!(
                refused(&flip(offset)),
                SongFileError::HeaderTag,
                "byte {offset}"
            );
        }

        // A byte of the header and index tag, 345–360.
        assert!(variants[4].contains("345–360"));
        for offset in 345..361 {
            assert_eq!(
                refused(&flip(offset)),
                SongFileError::HeaderTag,
                "byte {offset}"
            );
        }

        // A byte of any chunk's ciphertext or tag. Each chunk fails at its
        // own position.
        assert!(variants[5].starts_with("A byte of any chunk"));
        let ends = [361, 388, 414, 450, 495, 513, 562, 580];
        for (position, bounds) in ends.windows(2).enumerate() {
            for offset in bounds[0]..bounds[1] {
                assert_eq!(
                    refused(&flip(offset)),
                    SongFileError::ChunkTag { position },
                    "byte {offset}"
                );
            }
        }

        // The last byte is removed, and a byte is added.
        assert!(variants[6].contains("579"));
        assert_eq!(
            refused(&file[..579]),
            SongFileError::FileSize {
                size: 579,
                end: 580
            }
        );
        assert!(variants[7].contains("581"));
        let mut padded = file.clone();
        padded.push(0);
        assert_eq!(
            refused(&padded),
            SongFileError::FileSize {
                size: 581,
                end: 580
            }
        );

        // The two 18-byte media segments are swapped.
        assert!(variants[8].contains("swapped"));
        let mut swapped = file.clone();
        let (karaoke, original) = (swapped[495..513].to_vec(), swapped[562..580].to_vec());
        swapped[495..513].copy_from_slice(&original);
        swapped[562..580].copy_from_slice(&karaoke);
        assert_eq!(refused(&swapped), SongFileError::ChunkTag { position: 4 });

        // Two index entries are swapped.
        assert!(variants[9].contains("swapped or reordered"));
        let mut reordered = file.clone();
        let (first, second) = (
            reordered[177 + 4 * 24..][..24].to_vec(),
            reordered[177 + 6 * 24..][..24].to_vec(),
        );
        reordered[177 + 4 * 24..][..24].copy_from_slice(&second);
        reordered[177 + 6 * 24..][..24].copy_from_slice(&first);
        assert_eq!(refused(&reordered), SongFileError::HeaderTag);

        // A chunk is dropped and the index is edited.
        assert!(variants[10].starts_with("A chunk is dropped"));
        let mut dropped = file[..562].to_vec();
        dropped[177 + 6 * 24 + 4..][..4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(refused(&dropped), SongFileError::HeaderTag);

        // A wrong content key.
        assert!(variants[11].starts_with("A wrong content key"));
        let wrong = ContentKey::from_bytes([0x41; 32]);
        assert_eq!(read(&file, &wrong), Err(SongFileError::HeaderTag));
    }

    #[test]
    fn a_file_with_fewer_entries_than_the_limit_is_refused_by_its_header() {
        let mut file = documented_example();
        file[12..16].copy_from_slice(&6u32.to_le_bytes());
        assert_eq!(refused(&file), SongFileError::EntryCount { count: 6 });
        let mut reserved = documented_example();
        reserved[10] = 1;
        assert_eq!(
            refused(&reserved),
            SongFileError::HeaderReserved { value: 1 }
        );
    }

    #[test]
    fn the_header_is_exactly_177_bytes() {
        let file = documented_example();
        assert_eq!(
            Header::parse(&file[..176]),
            Err(SongFileError::HeaderTooShort {
                len: 176,
                needed: 177
            })
        );
        assert!(Header::parse(&file[..177]).is_ok());
        assert_eq!(
            Header::parse(&[]),
            Err(SongFileError::HeaderTooShort {
                len: 0,
                needed: 177
            })
        );
    }

    #[test]
    fn a_file_too_short_for_its_index_and_tag_is_refused() {
        let file = documented_example();
        assert_eq!(
            refused(&file[..300]),
            SongFileError::IndexLength {
                len: 123,
                expected: 184
            }
        );
        assert_eq!(
            refused(&file[..360]),
            SongFileError::IndexLength {
                len: 183,
                expected: 184
            }
        );
    }

    #[test]
    fn the_tag_is_checked_before_the_file_size() {
        let file = documented_example();
        let header = Header::parse(&file).expect("the header is valid");
        let wrong = ContentKey::from_bytes([0; 32]);
        // The size is wrong too, and the tag fails first.
        assert_eq!(
            Index::open(&header, &wrong, &file[177..361], 100).err(),
            Some(SongFileError::HeaderTag)
        );
        assert_eq!(
            Index::open(&header, &content_key(), &file[177..361], 100).err(),
            Some(SongFileError::FileSize {
                size: 100,
                end: 580
            })
        );
        assert_eq!(
            Index::open(&header, &content_key(), &file[177..360], 580).err(),
            Some(SongFileError::IndexLength {
                len: 183,
                expected: 184
            })
        );
    }

    #[test]
    fn reads_one_chunk_at_a_time() {
        let file = documented_example();
        let header = Header::parse(&file).expect("the header is valid");
        let index = Index::open(&header, &content_key(), &file[177..361], 580).expect("valid");
        assert_eq!(index.duration_ms(), 1000);
        let entry = &index.entries()[4];
        let stored = &file[entry.offset as usize..][..entry.length as usize];
        assert_eq!(
            index.read_chunk(4, stored),
            Ok(Chunk::Media(b"ks".to_vec()))
        );
        // A chunk read under another position does not authenticate.
        assert_eq!(
            index.read_chunk(6, stored).err(),
            Some(SongFileError::ChunkTag { position: 6 })
        );
        assert_eq!(
            index.read_chunk(7, stored).err(),
            Some(SongFileError::NoEntry { position: 7 })
        );
        assert_eq!(
            index.read_chunk(4, &stored[1..]).err(),
            Some(SongFileError::ChunkBytes {
                chunk_type: 19,
                len: 17,
                expected: 18
            })
        );
    }

    /// Lays out the example with the first chunk of `chunk_type` of `plain`
    /// bytes before its tag, and checks it as version 1.
    fn check_stored(chunk_type: ChunkType, plain: usize) -> Result<u32, SongFileError> {
        let (entries, size) = layout_framed(&with_length(chunk_type, plain), V1)?;
        validate_framed(&entries, size, V1)
    }

    #[test]
    fn stored_lengths_are_the_limits_of_the_doc() {
        // The stored limits of the doc's table: the version 0 limits plus 16.
        let limits = [
            (ChunkType::SongDetails, 24, 3_095),
            (ChunkType::Thumbnail, 17, 1_048_592),
            (ChunkType::Lyrics, 17, 1_048_592),
            (ChunkType::Timing, 28, 524_308),
            (ChunkType::OriginalInit, 20, 65_809),
            (ChunkType::KaraokeSegment, 17, 67_108_880),
        ];
        for (chunk_type, min, max) in limits {
            let tag = TAG_LEN;
            assert!(
                check_stored(chunk_type, min - tag).is_ok(),
                "{chunk_type:?} {min}"
            );
            assert!(
                check_stored(chunk_type, max - tag).is_ok(),
                "{chunk_type:?} {max}"
            );
            let too_long = SongFileError::ChunkLength {
                chunk_type: chunk_type.code(),
                length: max as u64 + 1,
            };
            assert_eq!(check_stored(chunk_type, max - tag + 1), Err(too_long));
            let too_short = SongFileError::ChunkLength {
                chunk_type: chunk_type.code(),
                length: min as u64 - 1,
            };
            assert_eq!(check_stored(chunk_type, min - tag - 1), Err(too_short));
        }
        // A timing chunk is 4 + 8 × count bytes before its tag.
        assert_eq!(
            check_stored(ChunkType::Timing, 13),
            Err(SongFileError::ChunkLength {
                chunk_type: 4,
                length: 29
            })
        );
        // Under the tag size there is no plaintext length at all.
        let (mut entries, size) =
            layout_framed(&with_length(ChunkType::Lyrics, 10), V1).expect("laid out");
        entries[1].length = 15;
        assert_eq!(
            validate_framed(&entries, size, V1),
            Err(SongFileError::ChunkLength {
                chunk_type: 3,
                length: 15
            })
        );
    }

    #[test]
    fn a_round_trip_keeps_the_lyrics_byte_for_byte() {
        let nfc = "Mưa rơi\n";
        let nfd = "Mu\u{31B}a ro\u{31B}i\n";
        assert_ne!(nfc, nfd);
        let recovery = recovery_key().public_key();
        for text in [nfc, nfd] {
            let mut song = example_song();
            song.lyrics = lyrics(text);
            let key = ContentKey::generate();
            let file = write(&song, &key, &recovery, Salt::generate()).expect("valid");
            let read_back = read(&file, &key).expect("the file reads");
            assert_eq!(read_back.lyrics.as_bytes(), text.as_bytes());
            assert_eq!(read_back, song);
            // The lyrics are not in the file as they were supplied.
            assert!(
                !file
                    .windows(text.len())
                    .any(|window| window == text.as_bytes())
            );
        }
    }

    #[test]
    fn every_write_has_its_own_keys_and_bytes() {
        let recovery = recovery_key().public_key();
        let key = ContentKey::generate();
        let first = write(&example_song(), &key, &recovery, Salt::generate()).expect("valid");
        let second = write(&example_song(), &key, &recovery, Salt::generate()).expect("valid");
        assert_ne!(first[32..64], second[32..64]);
        assert_ne!(first[361..], second[361..]);
        assert_eq!(read(&first, &key), read(&second, &key));
    }

    /// A song whose karaoke and original tracks have two segments each.
    fn two_segment_song() -> Song {
        let mut song = example_song();
        song.karaoke = track(KARAOKE_TYPE, b"ki", &[(500, b"k1"), (500, b"k22")]);
        song.original = track(AAC_TYPE, b"oi", &[(500, b"o1"), (500, b"o22")]);
        song
    }

    #[test]
    fn a_changed_segment_is_refused_when_it_is_read_and_the_chunks_before_it_still_read() {
        let song = two_segment_song();
        let key = ContentKey::generate();
        let mut file =
            write(&song, &key, &recovery_key().public_key(), Salt::generate()).expect("valid");
        let header = Header::parse(&file).expect("the header is valid");
        let index_end = HEADER_LEN + header.index_len() + TAG_LEN;
        let index = Index::open(
            &header,
            &key,
            &file[HEADER_LEN..index_end],
            file.len() as u64,
        )
        .expect("the index is valid");
        // The second karaoke segment is the sixth chunk, at position 5.
        let changed = &index.entries()[5];
        assert_eq!(changed.chunk_type, ChunkType::KaraokeSegment);
        let last = (changed.offset + u64::from(changed.length) - 1) as usize;
        file[last] ^= 0x80;

        let stored = |position: usize| {
            let entry = &index.entries()[position];
            &file[entry.offset as usize..][..entry.length as usize]
        };
        for position in 0..5 {
            assert!(
                index.read_chunk(position, stored(position)).is_ok(),
                "{position}"
            );
        }
        assert_eq!(
            index.read_chunk(5, stored(5)),
            Err(SongFileError::ChunkTag { position: 5 })
        );
        // The chunks after it read too: each is checked on its own.
        for position in 6..index.entries().len() {
            assert!(
                index.read_chunk(position, stored(position)).is_ok(),
                "{position}"
            );
        }
        assert_eq!(
            read(&file, &key),
            Err(SongFileError::ChunkTag { position: 5 })
        );
    }

    #[test]
    fn the_writer_refuses_a_plan_the_reader_would_reject_before_any_byte() {
        let recovery = recovery_key().public_key();
        let key = content_key();
        let mut mismatched = example_song();
        mismatched.timing = timing(&[(0, 300), (300, 600), (600, 900)]);
        let mut wrong_type = example_song();
        wrong_type.karaoke.stored_type = AAC_TYPE.to_owned();
        let mut cut = example_song();
        cut.original.segments[0].duration_ms = 949;
        let expected = [
            SongFileError::SyllableMismatch {
                count: 3,
                expected: 2,
            },
            SongFileError::StoredTypeContainer { chunk_type: 18 },
            SongFileError::SegmentMismatch { position: 6 },
        ];
        for (song, expected) in [mismatched, wrong_type, cut].into_iter().zip(expected) {
            let plan = plan_song(&song).expect("a planned song");
            let refused = PieceWriter::new(plan, &key, &recovery, Salt::generate()).err();
            assert_eq!(refused, Some(expected.clone()));
            // `write` gives the same reason, and the same one as version 0.
            assert_eq!(
                write(&song, &key, &recovery, Salt::generate()),
                Err(expected.clone())
            );
            assert_eq!(crate::song_file::write(&song), Err(expected));
        }
    }

    #[test]
    fn writes_in_pieces_as_write_does() {
        let song = two_segment_song();
        let key = content_key();
        let recovery = recovery_key().public_key();
        let plan = plan_song(&song).expect("a planned song");
        let mut writer =
            PieceWriter::new_with_rng(plan, &key, &recovery, example_salt(), &mut example_ikm())
                .expect("valid");
        let mut pieces = vec![writer.head().to_vec()];
        let mut segments = crate::song_file::Segments::new(&song);
        loop {
            match writer.next_chunk() {
                Next::Chunk(bytes) => pieces.push(bytes),
                Next::Segment(chunk_type) => {
                    let bytes = segments.next(chunk_type).to_vec();
                    pieces.push(writer.segment(bytes).expect("the length is planned"));
                }
                Next::End => break,
            }
        }
        // The header, the index and the tag, then the 9 chunks.
        assert_eq!(pieces.len(), 1 + 9);
        assert_eq!(pieces[0].len(), HEADER_LEN + 9 * INDEX_ENTRY_LEN + TAG_LEN);
        let file = pieces.concat();
        assert_eq!(file.len() as u64, writer.file_size());
        let whole = write_with_rng(&song, &key, &recovery, example_salt(), &mut example_ikm())
            .expect("valid");
        assert_eq!(file, whole);
        assert_eq!(read(&file, &key), Ok(song));
    }

    #[test]
    fn refuses_a_media_segment_of_the_wrong_length_and_keeps_waiting_for_it() {
        let plan = plan_song(&example_song()).expect("a planned song");
        let mut writer = PieceWriter::new(
            plan,
            &content_key(),
            &recovery_key().public_key(),
            Salt::generate(),
        )
        .expect("valid");
        loop {
            match writer.next_chunk() {
                Next::Chunk(_) => {}
                Next::Segment(_) => break,
                Next::End => panic!("the example has segments"),
            }
        }
        assert_eq!(
            writer.segment(b"ks!".to_vec()),
            Err(SongFileError::ChunkBytes {
                chunk_type: 19,
                len: 3,
                expected: 2
            })
        );
        assert_eq!(
            writer.next_chunk(),
            Next::Segment(ChunkType::KaraokeSegment)
        );
        assert_eq!(
            writer.segment(b"ks".to_vec()).map(|bytes| bytes.len()),
            Ok(18)
        );
    }

    #[test]
    fn writes_a_song_with_a_thumbnail_and_a_video() {
        let mut song = example_song();
        song.thumbnail = Some(b"thumb".to_vec());
        song.details = details("Mưa", "Ca sĩ", "Nhạc sĩ", VocalRole::Male);
        song.video = Some(track(
            "video/webm; codecs=\"vp09.00.40.08\"",
            b"vi",
            &[(400, b"v1"), (300, b"v22"), (300, b"v333")],
        ));
        song.karaoke = track(
            KARAOKE_TYPE,
            b"ki",
            &[(400, b"k1"), (300, b"k22"), (300, b"k333")],
        );
        song.original = track(
            AAC_TYPE,
            b"oi",
            &[(400, b"o1"), (300, b"o22"), (300, b"o333")],
        );
        let key = ContentKey::generate();
        let file =
            write(&song, &key, &recovery_key().public_key(), Salt::generate()).expect("valid");
        assert_eq!(read(&file, &key), Ok(song));
    }

    #[test]
    fn no_error_or_debug_text_holds_a_key_or_lyrics() {
        let file = documented_example();
        let keys = Keys::derive(&example_salt().0, &content_key());
        let secrets = [
            hex(content_key().expose()),
            hex(&*keys.header),
            hex(&*keys.chunk.0),
            "Mưa".to_owned(),
            "rơi".to_owned(),
        ];
        let check = |text: String| {
            for secret in &secrets {
                assert!(!text.contains(secret), "{text} holds {secret}");
            }
        };

        // Every error of the invalid variants, and the other new ones.
        let mut errors = vec![
            SongFileError::HeaderTag,
            SongFileError::ChunkTag { position: 3 },
            SongFileError::NoEntry { position: 9 },
            SongFileError::HeaderTooShort {
                len: 1,
                needed: 177,
            },
        ];
        errors.push(refused(&example()));
        errors.push(refused(&file[..579]));
        for offset in [0, 20, 100, 200, 350, 400, 500, 570] {
            let mut changed = file.clone();
            changed[offset] ^= 1;
            errors.push(refused(&changed));
        }
        errors.push(read(&file, &ContentKey::from_bytes([1; 32])).expect_err("wrong key"));
        for error in errors {
            check(error.to_string());
            check(format!("{error:?}"));
            check(format!("{error:#?}"));
        }

        let header = Header::parse(&file).expect("the header is valid");
        let index = Index::open(&header, &content_key(), &file[177..361], 580).expect("valid");
        check(format!("{index:?}"));
        check(format!("{index:#?}"));
        assert!(format!("{index:?}").contains("ChunkKey { .. }"));
        let plan = plan_song(&example_song()).expect("a planned song");
        let writer = PieceWriter::new_with_rng(
            plan,
            &content_key(),
            &recovery_key().public_key(),
            example_salt(),
            &mut example_ikm(),
        )
        .expect("valid");
        check(format!("{writer:?}"));
        check(format!("{writer:#?}"));
        check(format!("{:?}", example_salt()));
        check(format!(
            "{:?}",
            Keys::derive(&example_salt().0, &content_key()).chunk
        ));
    }
}
