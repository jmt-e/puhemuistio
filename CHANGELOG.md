# Changelog

What changed in each version of Puhemuistio, newest first. The app shows
the same list in Settings → Version history.

<!-- Generated from js/changelog.js by scripts/changelog-md.mjs. Edit that file, not this one. -->

## 0.4.2 (2026-10-21)

- If the app closes while transcribing, the note now says at which step (downloading, loading the model or transcribing), with which model and chip.
- One-tap retry with the Fast model, or without the graphics chip.

## 0.4.1 (2026-10-21)

- Fixed: Safari crashed ("A problem repeatedly occurred") while the speech model was downloading. Checking the download no longer loads the model into memory.
- If a download keeps stopping without progress, the app stops retrying on its own and tells you, instead of crashing again.

## 0.4.0 (2026-10-21)

- Version history in Settings, and a short notice after the app updates.
- The same list is in CHANGELOG.md in the project on GitHub.

## 0.3.0 (2026-10-21)

- The speech model download continues where it stopped if the app is closed, the screen locks or the network drops.
- An unfinished download continues by itself when you open the app again.
- The screen stays on while the model downloads, and the notes list shows the progress.

## 0.2.1 (2026-10-21)

- Fixed: the model download failed on iPhone with "Load failed".
- Downloads retry automatically when the connection drops for a moment.

## 0.2.0 (2026-10-21)

- Speech recognition on the phone. Two models in Settings: Accurate (Finnish Whisper medium) and Fast (Whisper small).
- Only the model files this phone needs are downloaded.
- Setting to stop using the graphics chip, if transcription misbehaves.

## 0.1.0 (2026-10-21)

- First version: record with pause and continue, notes with title and editable text, search, add to a note.
- Recordings survive a screen lock, a call or the app closing.
- Copy, Email, Share and Save as file, for one note or several.
- Backup export and import. Works offline.
