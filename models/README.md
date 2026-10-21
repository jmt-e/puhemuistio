# Speech models

Each model lives in `models/<id>/` in the layout Transformers.js expects
(`config.json`, `generation_config.json`, `preprocessor_config.json`,
tokenizer files, and `onnx/*.onnx`). `models.json` lists them for the app;
run `python3 scripts/update-manifest.py` after changing files.

## Status

No model is included yet. Hugging Face, where the Whisper model files are
published, was not reachable from the build environment when the proof of
concept was made. The app records, saves, edits and shares notes; speech
recognition starts working as soon as a model is added here.

Candidates and selection criteria: see "Choosing the model" in `CLAUDE.md`.
