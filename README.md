# Puhemuistio

Private voice notes for iPhone. Dictate a note after a customer visit, in
Finnish or English, and the phone turns it into text. Speech recognition runs
**on the phone** (Whisper in the browser); audio and text never leave the
phone unless you tap Copy, Email, Share, File or Export.

## Install on iPhone

1. Open the app's GitHub Pages address in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the Home Screen, go to Settings and download the speech model
   once (on Wi-Fi). After that it works offline.

## Privacy

- No servers, accounts, analytics or third-party files. Every file, including
  the AI model, comes from this repository.
- A Content-Security-Policy stops the app from connecting anywhere else.
- Notes are stored in the phone's browser storage (IndexedDB). Use
  Settings → Export to make a backup file.

## Development

Plain HTML, CSS and JavaScript, no build step. See `CLAUDE.md` for the design,
rules and roadmap, `CHANGELOG.md` for what changed in each version, and
`models/README.md` for how the speech models were chosen.

    node tests/serve.mjs 8080   # then open http://localhost:8080/

Third-party code: `vendor/transformers` (Transformers.js, Apache-2.0) and
`vendor/ort` (ONNX Runtime Web, MIT). Their licences are next to the files.
