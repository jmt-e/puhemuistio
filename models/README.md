# Speech models

Each model lives in `models/<id>/` in the layout Transformers.js expects
(`config.json`, `generation_config.json`, `preprocessor_config.json`,
tokenizer files, and `onnx/*.onnx` with their `*.onnx_data*` weight files).
`models.json` lists them for the app; run `python3 scripts/update-manifest.py`
after changing files.

## What ships

| In Settings | Model | Licence | Files | Size |
|---|---|---|---|---|
| **Accurate** (default) | [Finnish-NLP/whisper-medium-finnish](https://huggingface.co/Finnish-NLP/whisper-medium-finnish) | Apache-2.0 | encoder 4-bit, decoder 8-bit | 673 MB |
| **Fast** | [openai/whisper-small](https://huggingface.co/openai/whisper-small) (multilingual) | Apache-2.0 | encoder and decoder 8-bit | 256 MB |

Plus the ONNX Runtime WebAssembly files (41 MB). The whole site is about
971 MB, just under GitHub Pages' 1 GB limit: there is no room for a third
model without removing one.

## How they were chosen (October 2026)

Word error rate (WER, share of words wrong; lower is better) on 40 Finnish
and 40 English clips of the Google FLEURS test set, run with the app's own
Transformers.js version and generation settings (`scripts/eval-wer.mjs`).
Punctuation and case are ignored; numbers count as written, so all models
lose a few points on "25" vs "kaksikymmentäviisi".

| Model | Size | Finnish WER | English WER |
|---|---|---|---|
| Whisper base, multilingual, 8-bit | 77 MB | 86 % | 9.6 % |
| Whisper small, multilingual, 8-bit (**Fast**) | 256 MB | 29 % | 6–7 % |
| Finnish small fine-tune (sgangireddy/whisper-small-fi-full), 8-bit | 293 MB | 30 % | 9.4 % |
| **Finnish-NLP whisper-medium-finnish**, 4-bit encoder + 8-bit decoder (**Accurate**) | 673 MB | **10.0 %** | 9.7 % |
| same, all 8-bit | 836 MB | 10.3 % | 10.0 % |
| Mozilla AI whisper-large-v3-turbo-fi, 4-bit | 600 MB | 13.0 % | 4.8 % |
| Mozilla AI whisper-large-v3-turbo-fi, 8-bit | 900 MB | 14.5 % | 4.7 % |

Speed and memory in Chromium on a 4-core cloud machine, WebAssembly with 3
threads, 77 s of Finnish speech (`tests/bench.mjs`):

| Model | Time | Peak memory of the tab |
|---|---|---|
| Whisper small 8-bit (Fast) | 44 s | 1.0 GB |
| Whisper small 4-bit | 104 s | 1.1 GB |
| Finnish medium, 8-bit | 116 s | 2.0 GB |
| Finnish medium, 4-bit encoder + 8-bit decoder (Accurate) | 145 s | 2.0 GB |
| Finnish medium, 8-bit encoder + 4-bit decoder | 273 s | 1.9 GB |
| Finnish turbo, 4-bit | 278 s | 1.9 GB |

Findings:

- Small multilingual models are not usable for Finnish; the Finnish small
  fine-tune is no better than the original. The Finnish medium fine-tune
  cuts Finnish errors to a third.
- On the CPU (WebAssembly), 4-bit weights run 2–2.5× slower than 8-bit, so
  the decoder, which runs once per word, stays 8-bit. The encoder runs once
  per 30 s and is 4-bit to fit the 1 GB site limit.
- The turbo model is the best in English but slower and less accurate in
  Finnish than the medium model at the sizes that fit.
- Excluded for licence: RASMUS and swatchou Finnish small models (no licence).
  Excluded for size: Finnish-NLP large-v3 (8 % WER, 1.5 B parameters).
- Caveat: Finnish-NLP lists FLEURS among its training data (train split; we
  test on the test split), so its FLEURS score may flatter it a little. Its
  own Common Voice score is 12 %.
- WebGPU: the same files run on the GPU path (checked with a software GPU),
  but speed on an iPhone GPU is untested. If transcription is slow, compare
  with Settings → "Use the graphics chip" off.

## How the files were made

    pip install torch transformers optimum-onnx[onnxruntime] onnx onnxruntime
    optimum-cli export onnx -m <hf model> --task automatic-speech-recognition-with-past out/
    python3 scripts/quantize.py out/ prepared/ q8 q4
    python3 scripts/dedupe-tied.py prepared/onnx/decoder_model_merged_quantized.onnx
    # copy the configs and the chosen onnx files to models/<id>/, then for each .onnx:
    python3 scripts/split-model.py models/<id>/onnx/<file>.onnx
    python3 scripts/update-manifest.py

Notes: the Finnish medium export needs more than 15 GB of RAM in Optimum's
validation step, so its full-precision ONNX was taken from
[FredrikKarlssonSpeech/whisper-medium-finnish-onnx](https://huggingface.co/FredrikKarlssonSpeech/whisper-medium-finnish-onnx)
(Apache-2.0, an export of the same model) and quantized with these scripts.
Its `generation_config.json` is OpenAI's whisper-medium one (the fine-tune's
lacks the language table). `scripts/dedupe-tied.py` stores the tied token
embedding once (saves 39–53 MB per model).
