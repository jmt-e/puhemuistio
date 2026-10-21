# Puhemuistio: private voice notes (iPhone PWA)

After customer visits the owner dictates notes in Finnish or English. The app
turns speech into text **on the phone**. Customer information is
confidential: audio and text never leave the phone unless the user chooses
to share them.

We build this as a simple proof of concept and improve it step by step.

## Hard rules (never break these)

- Speech recognition runs on the phone with an AI model in the browser
  (Whisper via Transformers.js; WebGPU when available, WebAssembly otherwise).
- Never use the browser's built-in speech recognition (Web Speech API):
  Safari may send the audio to Apple's servers.
- Every file is hosted in this repo, model files included. No CDNs.
- The Content-Security-Policy blocks connections to other servers. It is in
  two places that must stay identical: the `<meta>` tag in `index.html` and
  `CSP` in `sw.js` (the service worker also covers workers, which ignore the
  meta tag). `connect-src` stays `'self'`.
- No uploads, analytics, trackers, or third-party scripts or fonts.
- Plain HTML, CSS and JavaScript, no build step: the repo runs on GitHub
  Pages as is. Libraries are fine if their files are copied into `vendor/`.
- Sharing happens only when the user taps a button. Nothing is ever sent
  automatically.
- Each file under 100 MB (GitHub's limit). The whole published site under
  1 GB (GitHub Pages' limit), so keep the total of all models in mind.

## Layout

| Path | What |
|---|---|
| `index.html` | All views (list, record, note, settings) and the CSP meta tag |
| `css/app.css` | Mobile-first styles, light and dark mode |
| `js/app.js` | UI, routing (`#/`, `#/record[/noteId]`, `#/note/id`, `#/settings`), transcription queue |
| `js/db.js` | IndexedDB: notes, audio, drafts + chunks (recording in progress), settings |
| `js/recorder.js` | Microphone → 16 kHz PCM, pause/continue, saved every second, wake lock, interruptions |
| `js/pcm-worklet.js` | AudioWorklet: resampling to 16 kHz mono Int16, level meter |
| `js/engine.js` | **The speech engine interface.** The only module the app calls for recognition |
| `js/engine-worker.js` | Web Worker running Whisper (Transformers.js), segmentation, fi/en detection |
| `js/model-files.js` | Model list (`models/models.json`), download into Cache Storage, offline |
| `js/share.js` | Copy, Email (mailto), Share sheet, .txt file |
| `js/backup.js` | Export/import all notes as one JSON file (audio optional) |
| `sw.js` | Service worker: offline cache, CSP + cross-origin isolation headers, blocks other origins |
| `models/<id>/` | Model files in Transformers.js layout (`config.json`, tokenizer, `onnx/*.onnx`) |
| `models/models.json` | Model list shown in Settings; `files`/`runtime` filled by `scripts/update-manifest.py` |
| `vendor/transformers/` | Transformers.js 4.3.1 `transformers.min.js` (bundles the ONNX Runtime JS) |
| `vendor/ort/` | ONNX Runtime Web WASM files matching that build (plain + asyncify/WebGPU) |
| `tests/` | Local server and Playwright end-to-end tests with a fake microphone |

## How things work

- **Recording**: AudioWorklet captures 16 kHz mono 16-bit PCM. While recording,
  audio is written to IndexedDB (`drafts` + `chunks`) every second, so a
  screen lock, call, app switch or even Safari killing the page loses at most
  a second. Going to the background or an interruption pauses automatically;
  the mic is released while paused. On return, the draft can be continued.
  The timer counts recorded samples, so it stops during a pause. Limit:
  `MAX_SECONDS` in `recorder.js` (5 min).
- **Stop** turns the draft into a note in one transaction (`db.commitDraft`),
  then transcription is queued. `note.pendingFrom` = sample offset where
  untranscribed audio starts. "Add to note" appends audio and transcribes only
  the new part; its text goes at the end of the note.
- **Transcription** (`engine-worker.js`): audio is cut into ≤28 s pieces at the
  quietest moment, silent pieces are skipped, each piece goes through Whisper.
  "Auto" language compares Whisper's `<|fi|>` and `<|en|>` token scores on the
  first piece (Transformers.js has no language detection of its own and would
  default to English). If WebGPU fails, the engine falls back to WASM.
- **Crash-loop guard**: `note.transcribing` is set during a job. If the app
  starts and finds it set (Safari killed the page, e.g. out of memory), it
  shows an error instead of retrying automatically.
- **Models** are downloaded only from this site, into Cache Storage
  (`puhemuistio-models-v1`) by `model-files.js`, with progress. The worker's
  `env.fetch` reads from that cache first. Transformers.js' own caches are
  off so the model isn't stored twice. Downloads never start on their own,
  except when the user stops a recording and no model is on the phone yet.
- **Service worker** adds COOP/COEP headers, making the page cross-origin
  isolated, so ONNX Runtime can use several CPU threads. This takes effect
  from the second page load. It answers requests to other origins with 403.
- **Storage**: `navigator.storage.persist()` is requested on first recording
  and model download. iOS honours it best for Home Screen apps.

## Conventions

- When changing any app file, bump `VERSION` in `sw.js` (and `APP_VERSION`
  in `js/app.js` for user-visible releases) so phones pick up the change.
- After changing model files: `python3 scripts/update-manifest.py`.
- `env.localModelPath` must be a path, not a full URL (Transformers.js 4
  skips local lookups for http URLs).
- UI text is English; notes are Finnish or English.
- Test locally: `node tests/serve.mjs 8080`, then the Playwright tests:
  `node tests/e2e.mjs <speech.wav> fi|en|auto [modelId]` and
  `node tests/e2e-recovery.mjs <a.wav> <b.wav>` (WAV files are the fake mic).

## Choosing the model

Finnish accuracy matters most. Candidates to compare (on a Finnish test set,
same code path as the app):

- Multilingual Whisper base and small (`onnx-community/whisper-*`): small
  multilingual models are weak in Finnish.
- Finnish fine-tunes with a licence that allows hosting in a public repo,
  e.g. Finnish-NLP's Whisper fine-tunes (tiny, medium, large-v2, large-v3)
  and community small fine-tunes. Converted to ONNX with Optimum if needed,
  quantised (q8 for WASM, q4/fp16 for WebGPU), split with ONNX external
  data chunks (`*.onnx_data`, `*.onnx_data_1`, … via
  `transformers.js_config.use_external_data_format`) to stay under 100 MB
  per file.
- Must run on an iPhone without crashing Safari (memory), and the total
  site must stay under 1 GB.
- Offer "Fast" and "Accurate" in Settings when practical.

Status and the decision are recorded in `models/README.md`.

## Roadmap (after the proof of concept)

1. Longer recordings, for example whole meetings (compress stored audio,
   transcribe in the background in parts as recording goes on).
2. Automatic summary and to-do list from a note with a small on-phone AI
   model.
3. Tags, a customer list, and export in a CRM-friendly format.
4. Better Finnish accuracy by running a large Whisper model on the owner's
   Windows PC: a second engine behind `js/engine.js` that sends audio to the
   PC on the local network only when the user chooses it. This needs a
   deliberate, narrow CSP change (`connect-src` for that one address) and
   must stay opt-in.
