// Version history, newest first. Shown in Settings → Version history.
// The first entry's version is the app's version (APP_VERSION in app.js).
// Add an entry for every release the owner will notice, in plain words.

export const CHANGELOG = [
  {
    version: '0.4.1',
    date: '2026-10-21',
    changes: [
      'Fixed: Safari crashed ("A problem repeatedly occurred") while the speech model was downloading. Checking the download no longer loads the model into memory.',
      'If a download keeps stopping without progress, the app stops retrying on its own and tells you, instead of crashing again.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-21',
    changes: [
      'Version history in Settings, and a short notice after the app updates.',
      'The same list is in CHANGELOG.md in the project on GitHub.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-21',
    changes: [
      'The speech model download continues where it stopped if the app is closed, the screen locks or the network drops.',
      'An unfinished download continues by itself when you open the app again.',
      'The screen stays on while the model downloads, and the notes list shows the progress.',
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-21',
    changes: [
      'Fixed: the model download failed on iPhone with "Load failed".',
      'Downloads retry automatically when the connection drops for a moment.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-21',
    changes: [
      'Speech recognition on the phone. Two models in Settings: Accurate (Finnish Whisper medium) and Fast (Whisper small).',
      'Only the model files this phone needs are downloaded.',
      'Setting to stop using the graphics chip, if transcription misbehaves.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-21',
    changes: [
      'First version: record with pause and continue, notes with title and editable text, search, add to a note.',
      'Recordings survive a screen lock, a call or the app closing.',
      'Copy, Email, Share and Save as file, for one note or several.',
      'Backup export and import. Works offline.',
    ],
  },
];
