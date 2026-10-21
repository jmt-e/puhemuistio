// Speech recognition worker: Whisper running in the browser via
// Transformers.js + ONNX Runtime. Every file it loads comes from this site
// (models/ and vendor/), never from Hugging Face or a CDN.
//
// Messages in:  { id, type: 'load', model, device }
//               { id, type: 'transcribe', model, device, audio (Float32 16 kHz), language }
// Messages out: { id, type: 'progress', ... } then { id, type: 'done', result } or { id, type: 'error', message }

import {
  env,
  AutoProcessor,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  LogitsProcessorList,
  WhisperTextStreamer,
} from '../vendor/transformers/transformers.min.js';
import { MODEL_CACHE } from './model-files.js';

const BASE = new URL('../', import.meta.url).href;
const SAMPLE_RATE = 16000;

env.allowRemoteModels = false;
env.allowLocalModels = true;
// A path, not a full URL: Transformers.js 4 skips its local-file lookup for
// http(s) URLs and would then find no tokenizer.
env.localModelPath = new URL('models/', BASE).pathname;
// We cache model files ourselves (see model-files.js), so the library must
// not keep a second copy of a few hundred megabytes.
env.useBrowserCache = false;
env.useWasmCache = false;
// Serve model files from our cache when they're there; otherwise from this
// site. Anything else is refused, as a second line behind the CSP.
env.fetch = async (url, init) => {
  const abs = new URL(url, BASE).href;
  if (!abs.startsWith(BASE)) throw new Error('Blocked request to another server: ' + abs);
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(abs);
    if (hit) return hit;
  } catch {
    // Cache API unavailable (private mode): fall through to the network.
  }
  return fetch(abs, init);
};

let current = null; // { key, processor, model, device }

function setWasmPaths(device) {
  // The ".asyncify" build supports WebGPU; the plain build is smaller and is
  // what Safari before 26 needs without WebGPU.
  const name = device === 'webgpu' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded';
  env.backends.onnx.wasm.wasmPaths = {
    mjs: BASE + `vendor/ort/${name}.mjs`,
    wasm: BASE + `vendor/ort/${name}.wasm`,
  };
  // Threads need cross-origin isolation, which our service worker provides.
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    : 1;
}

async function load(spec, device, report) {
  const key = spec.id + '|' + device;
  if (current?.key === key) return current;
  if (current) {
    await current.model.dispose().catch(() => {});
    current = null;
  }
  setWasmPaths(device);
  const progress = (p) => {
    if (p.status === 'progress' && p.total) report({ stage: 'load', file: p.file, loaded: p.loaded, total: p.total });
  };
  const processor = await AutoProcessor.from_pretrained(spec.id, { progress_callback: progress });
  const model = await WhisperForConditionalGeneration.from_pretrained(spec.id, {
    dtype: spec.dtype[device] || spec.dtype.wasm,
    device,
    progress_callback: progress,
  });
  current = { key, processor, model, device };
  return current;
}

// ---------- audio segmentation ----------

const FRAME = 320; // 20 ms
const MAX_SEG = 28 * SAMPLE_RATE; // Whisper sees 30 s windows; leave margin
const MIN_SEG = 15 * SAMPLE_RATE;
const SILENCE_RMS = 0.004;

function frameRms(audio) {
  const n = Math.floor(audio.length / FRAME);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += audio[i] * audio[i];
    rms[f] = Math.sqrt(s / FRAME);
  }
  return rms;
}

/** Split audio into ≤28 s pieces, cutting at the quietest moment, and drop silent pieces. */
export function segment(audio) {
  const rms = frameRms(audio);
  const pieces = [];
  let start = 0;
  while (audio.length - start > MAX_SEG) {
    // Quietest 300 ms between 15 s and 28 s from the start.
    const win = 15;
    const from = Math.floor((start + MIN_SEG) / FRAME);
    const to = Math.floor((start + MAX_SEG) / FRAME) - win;
    let best = to, bestE = Infinity;
    for (let f = from; f <= to; f++) {
      let e = 0;
      for (let k = 0; k < win; k++) e += rms[f + k] || 0;
      if (e < bestE) { bestE = e; best = f; }
    }
    const cut = (best + Math.floor(win / 2)) * FRAME;
    pieces.push([start, cut]);
    start = cut;
  }
  if (audio.length - start > 0) pieces.push([start, audio.length]);

  return pieces.filter(([a, b]) => {
    if (b - a < 0.3 * SAMPLE_RATE) return false;
    let peak = 0;
    for (let f = Math.floor(a / FRAME); f < Math.floor(b / FRAME); f++) peak = Math.max(peak, rms[f] || 0);
    return peak >= SILENCE_RMS;
  });
}

// ---------- language detection ----------

class CaptureLogits extends LogitsProcessor {
  _call(input_ids, logits) {
    this.logits = logits;
    return logits;
  }
}

/** Finnish or English, from Whisper's own language-token probabilities. */
async function detectLanguage(model, input_features) {
  const gc = model.generation_config;
  const fi = gc.lang_to_id?.['<|fi|>'];
  const en = gc.lang_to_id?.['<|en|>'];
  if (fi == null || en == null) return 'fi';
  const capture = new CaptureLogits();
  const list = new LogitsProcessorList();
  list.push(capture);
  await model.generate({
    inputs: input_features,
    decoder_input_ids: [gc.decoder_start_token_id],
    max_new_tokens: 1,
    logits_processor: list,
  });
  const data = capture.logits.data;
  const vocab = capture.logits.dims.at(-1);
  const row = data.length - vocab; // last (only) row
  return data[row + fi] >= data[row + en] ? 'fi' : 'en';
}

// ---------- transcription ----------

const LANG_NAME = { fi: 'finnish', en: 'english' };

async function transcribe({ model: spec, device, audio, language }, report) {
  const { processor, model } = await load(spec, device, report);
  const pieces = segment(audio);
  const total = pieces.reduce((s, [a, b]) => s + (b - a), 0) || 1;
  let done = 0;
  let lang = language === 'auto' ? null : language;
  const texts = [];

  report({ stage: 'transcribe', fraction: 0 });
  for (const [a, b] of pieces) {
    const { input_features } = await processor(audio.subarray(a, b));
    if (!lang) lang = await detectLanguage(model, input_features);

    const len = b - a;
    const expectedTokens = Math.max(8, (len / SAMPLE_RATE) * 4);
    let tokens = 0;
    let partial = '';
    const streamer = new WhisperTextStreamer(processor.tokenizer, {
      skip_prompt: true,
      callback_function: (t) => {
        partial += t;
        report({ stage: 'transcribe', fraction: (done + len * Math.min(0.95, tokens / expectedTokens)) / total, partial: [...texts, partial].join(' ') });
      },
      token_callback_function: () => { tokens++; },
    });

    const out = await model.generate({
      inputs: input_features,
      language: LANG_NAME[lang],
      task: 'transcribe',
      max_new_tokens: 440,
      streamer,
    });
    const text = processor.tokenizer.batch_decode(out, { skip_special_tokens: true })[0].trim();
    if (text) texts.push(text);
    done += len;
    report({ stage: 'transcribe', fraction: done / total, partial: texts.join(' ') });
  }
  return { text: texts.join(' ').replace(/\s+/g, ' ').trim(), language: lang || language };
}

self.onmessage = async (e) => {
  const msg = e.data;
  const report = (p) => self.postMessage({ id: msg.id, type: 'progress', ...p });
  try {
    let result;
    if (msg.type === 'load') {
      await load(msg.model, msg.device, report);
      result = { device: msg.device };
    } else if (msg.type === 'transcribe') {
      result = await transcribe(msg, report);
    }
    self.postMessage({ id: msg.id, type: 'done', result });
  } catch (err) {
    console.error(err);
    self.postMessage({ id: msg.id, type: 'error', message: String(err?.message || err) });
  }
};
