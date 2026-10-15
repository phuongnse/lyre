# Lyre product brief

## What Lyre is

Lyre turns a video or audio file and its exact lyrics into a karaoke song,
and plays it. It separates the vocals from the music, times every syllable of
the lyrics against the singing, and highlights the words as they are sung.
The singer can switch between the karaoke track and the original song at any
moment.

Everything happens on the user's own device. Songs are made in the browser
on that device, and play there or in the Android app (see
[decisions](decisions.md) D3 and D27). Each song is saved as one
encrypted `.lyre` file. It opens only on the devices its owner shared it with
(D6), wherever the file itself ends up.

## Who uses it

| Role | Needs |
| --- | --- |
| **Owner** | Makes songs from their own media and lyrics, keeps a library of them, plays them, and shares chosen songs with chosen people. Can recover their songs on a new device. |
| **Recipient** | Plays the songs an owner shared with their device. Sends their device code to an owner to receive songs. |
| **Anyone else** | Someone who got a `.lyre` file without being given access. Must not be able to play it. |

One person can be an owner on one device and a recipient of other people's
songs at the same time.

## Product goals

1. **Exact lyrics.** The words on screen are exactly the words the owner
   supplied. Lyre times them and never rewrites them (D5).
2. **Good karaoke.** A clean karaoke track, the original track to sing along
   with, and a highlight that follows the singer syllable by syllable.
3. **Private by default.** Media and lyrics never leave the device for
   processing. A song file is useless to anyone whose device was not given
   access (D6).
4. **Fast on the device it runs on.** Making a song uses the device's GPU
   through WebGPU. Lyre says before starting when a device cannot make songs
   (D25).
5. **One song file for every device.** The web client makes, plays and
   shares songs on a desktop or a phone. The Android app plays and receives
   them (D27).
6. **Honest about its protection.** Lyre's docs and screens say what the
   encryption protects and what it does not. See
   [knowledge](domain/knowledge.md#what-the-protection-does-not-do).

## Out of scope for now

- Commercial use and distribution of songs to the public. Commercial use
  would first need every non-commercial (CC-BY-NC) model replaced. Not every
  model licence is settled yet, for example for the fallback separator, see
  [knowledge](domain/knowledge.md#models-and-licences).
- Recognising lyrics from the audio. Lyre always needs the owner's lyrics.
- Revoking a share once it is given (D9).
- Any Lyre server or account (D9).
- iOS and desktop apps. The web client covers desktops.
- Making or sharing songs in the Android app (D27).

## The first journey

1. The owner opens Lyre and picks a video of a song and a `.txt` file with its
   exact lyrics.
2. Lyre downloads the models it needs the first time, checks them, and
   processes the song on the device, showing progress. The owner can cancel.
3. The new song appears in the library. The owner plays it: the video fills
   the screen, the lyrics are highlighted as they are sung, and the owner
   switches between Karaoke and Original.
4. A friend opens Lyre on their phone and sends the owner their device code.
   The owner shares the song with that code and sends the friend the song
   file and the access file.
5. The friend plays the song on their phone. A third person who got the same
   files cannot play it.

## Scenarios Lyre must pass

- A song made in the web client plays in the Android app and in the web
  client of another device.
- The lyrics on screen match the supplied text byte for byte, including
  Vietnamese diacritics.
- A device that was not given access cannot play the song, even with the song
  file, the access file meant for another device and that device's code.
- A changed or truncated song file never plays changed content: a truncated
  file, or a change in the header, index, details, lyrics or timing, is
  rejected before anything plays; a changed media segment stops playback
  when it is reached.
- The owner restores every song on a new device with the recovery key.
- Processing that is cancelled, or stops because the page closed, leaves no
  half-made song and can start again.
- A device below the requirements for making songs says so before starting,
  and starts nothing.
