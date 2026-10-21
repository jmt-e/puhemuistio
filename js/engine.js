// The speech recognition engine. The rest of the app talks only to this
// module, so a different model, or later a PC on the local network, can take
// over by changing this file alone.
//
//   engine.models()                       -> model list (from models/models.json)
//   engine.prepare(modelId, onProgress)   -> downloads the model to the phone if needed
//   engine.transcribe(pcm16k, { modelId, language, onProgress }) -> { text, language }
//
// The current engine runs Whisper on the phone in a Web Worker, on the GPU
// (WebGPU) when the phone has it, otherwise on the CPU (WebAssembly).

import {
  listModels, downloadModel, deleteModel, dtypeFor, bytesFor,
  isCached as isCachedFor, cachedBytes as cachedBytesFor, savedBytes as savedBytesFor,
} from './model-files.js';

let worker = null;
let nextId = 1;
const calls = new Map();
let devicePromise = null;
let gpuFailed = false;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    const call = calls.get(msg.id);
    if (!call) return;
    if (msg.type === 'progress') call.onProgress?.(msg);
    else {
      calls.delete(msg.id);
      if (msg.type === 'done') call.resolve(msg.result);
      else call.reject(new Error(msg.message));
    }
  };
  worker.onerror = (e) => {
    // The worker died (often: out of memory). Fail every pending call and
    // start a fresh worker next time.
    for (const call of calls.values()) call.reject(new Error(e.message || 'Speech engine stopped unexpectedly'));
    calls.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function call(msg, onProgress, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

let devicePref = 'auto';

/** 'auto' (GPU when available) or 'wasm' (always the CPU). */
export function setDevicePreference(pref) {
  devicePref = pref === 'wasm' ? 'wasm' : 'auto';
  devicePromise = null;
}

/** 'webgpu' if the phone has a usable GPU adapter (and it's allowed), else 'wasm'. */
export function pickDevice() {
  if (devicePref === 'wasm' || gpuFailed) return Promise.resolve('wasm');
  if (!devicePromise) {
    devicePromise = (async () => {
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        return adapter ? 'webgpu' : 'wasm';
      } catch {
        return 'wasm';
      }
    })();
  }
  return devicePromise;
}

export async function models() {
  return listModels();
}

export async function getModel(modelId) {
  const list = await listModels();
  return list.find((m) => m.id === modelId) || list.find((m) => m.default) || list[0] || null;
}

async function requireModel(modelId) {
  const model = await getModel(modelId);
  if (!model) throw new Error('No speech model is installed in this version of the app yet.');
  return model;
}

/** Download size of the model for this phone, in bytes. */
export async function modelBytes(model) {
  return bytesFor(model, await pickDevice());
}

export async function cachedBytes(model) {
  return cachedBytesFor(model, await pickDevice());
}

/** Bytes on the phone, including a download that stopped half-way. */
export async function savedBytes(model) {
  return savedBytesFor(model, await pickDevice());
}

export async function isCached(model) {
  return isCachedFor(model, await pickDevice());
}

export async function prepare(modelId, onProgress, signal) {
  const model = await requireModel(modelId);
  await downloadModel(model, await pickDevice(), onProgress, signal);
  return model;
}

export async function remove(modelId) {
  const model = await requireModel(modelId);
  await deleteModel(model);
}

/**
 * Transcribe 16 kHz mono audio.
 * onProgress({ stage: 'download'|'load'|'transcribe', fraction, partial? })
 */
export async function transcribe(audio, { modelId, language = 'fi', onProgress } = {}) {
  const model = await requireModel(modelId);
  const run = async (dev) => {
    if (!(await isCachedFor(model, dev))) {
      await downloadModel(model, dev, (p) => onProgress?.({ stage: 'download', fraction: p.loaded / p.total }));
    }
    // Copy: the buffer is transferred to the worker, and a retry needs it.
    const copy = audio.slice();
    return call(
      { type: 'transcribe', model, device: dev, dtype: dtypeFor(model, dev), audio: copy, language },
      (p) => {
        if (p.stage === 'load') onProgress?.({ stage: 'load', fraction: p.total ? p.loaded / p.total : 0 });
        else onProgress?.(p);
      },
      [copy.buffer],
    );
  };
  const device = await pickDevice();
  try {
    return await run(device);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // WebGPU on phones is young; fall back to the CPU for the rest of this session.
    console.warn('WebGPU failed, using WebAssembly', err);
    gpuFailed = true;
    return await run('wasm');
  }
}

export function currentDevice() {
  return gpuFailed ? Promise.resolve('wasm') : devicePromise || Promise.resolve(null);
}
