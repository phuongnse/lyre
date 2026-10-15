# Lyre concepts

This is the vocabulary used in code, file formats and UI. The **From** column
gives the milestone that introduces the concept (see the
[roadmap](../roadmap.md)). The docs sweep at milestone close checks this
column and moves a concept to a later milestone when it was not delivered.
See [the life of a milestone](../delivery.md#the-life-of-a-milestone).

## Songs

| Concept | Meaning | From |
| --- | --- | --- |
| **Source** | The video or audio file a song is made from. Lyre reads it and never changes it. | M2 |
| **Lyrics** | The exact UTF-8 text the owner supplied for a song, one sung phrase per line. Authoritative and never rewritten (D5). | M1 |
| **Lyric line** | One line of the lyrics as the owner wrote it, holding at least one syllable. Blank and whitespace-only lines stay in the lyrics but are not lyric lines. | M1 |
| **Syllable** | The unit Lyre times. In Vietnamese, each space-separated token of a lyric line is one syllable. | M1 |
| **Timing** | When each syllable starts and ends in the song, derived from the singing. Stored separately from the lyrics. | M1 |
| **Display line** | A line as shown on screen. A long lyric line may be shown as several display lines; each one points back to its lyric line. | M1 |
| **Karaoke track** | The music with the vocals removed. | M1 |
| **Original track** | The song as it was in the source, vocals included. | M1 |
| **Song** | One karaoke song: its media, both tracks, lyrics, timing, details (title, artist, composer, vocal role) and thumbnail. | M1 |
| **Song file** | A song stored as one `.lyre` file (D1). Encrypted from M3. | M1 |
| **Section** | A part of a source, between a start and an end time, that becomes its own song. Cut in the clip editor. | M6 |
| **Vocal role** | Who sings a song, or a lyric line or clause: male, female or duet. A song file records one role for the whole song. It sets the [colour](../ui-conventions.md#vocal-role-colours) of the song's sung lyrics. Roles per line come with M8. | M1 |

## Processing

| Concept | Meaning | From |
| --- | --- | --- |
| **Model** | A machine-learning model Lyre runs on the device in the web client (D27), for example to separate vocals or to time lyrics. Pinned by version and SHA-256 hash, downloaded on first use. | M2 |
| **Separation** | Splitting the source's audio into vocals and the karaoke track. | M2 |
| **Alignment** | Timing the supplied syllables against the vocals. It never recognises words (D5). | M2 |
| **Task** | One run of processing for one song in the web client (D27), with progress and the stage it is in. It can be cancelled, and leaves nothing behind when it fails. | M2 |

## Playing

| Concept | Meaning | From |
| --- | --- | --- |
| **Player** | Plays a song: video, the chosen track and the highlighted lyrics. | M1 |
| **Library** | The songs a device can play, from local files and, later, Google Drive. | M1 (basic), M5 |
| **Queue** | The songs lined up to play next, in order or shuffled. | M5 |
| **Drive source** | A Google Drive file or folder the user picked, read only, from which Lyre plays song files. | M7 |

## Devices and access

| Concept | Meaning | From |
| --- | --- | --- |
| **Device** | One phone, tablet or computer running Lyre. On the web, the machine, not the browser (D8). | M3 |
| **Device key** | A device's key pair. The private key never leaves the device (D6, D8). | M3 |
| **Device code** | A device's public key, encoded so a person can send it as text or a QR code. | M3 |
| **Fingerprint** | A short code derived from a device code, read aloud or compared by eye to make sure a device code was not swapped on the way. | M3 |
| **Content key** | The random key of one song. Each write of its song file derives the file's encryption keys from it. | M3 |
| **Access file** | A small `.lyrekey` file for one device that holds the wrapped content keys of one or more songs, each marked as the owner's or a recipient's. Lyre matches each to its song file by song ID. Without an entry for the device, the song does not open there. | M3 |
| **Owner** | The person who made a song. Their web client can share it (D27). | M3 |
| **Recipient** | A person whose device was given an access file for a song. | M3 |
| **Recovery key** | The owner's offline key, created before the first song and shown once as 24 words and a QR code. Every song the owner makes is also wrapped for it, so a new device can be given access to all of them (D7). | M3 |
