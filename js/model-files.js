// Model files: the list of models (models/models.json), and downloading them
// from this site into the phone's Cache Storage so speech recognition works
// offline. Only the files this phone will use are downloaded: a model folder
// can hold an 8-bit version for the CPU (WebAssembly) and a 4-bit version for
// the GPU (WebGPU). The download includes the ONNX Runtime files.
// Shared by the page and the engine worker.

export const MODEL_CACHE = 'puhemuistio-models-v1';

const BASE = new URL('../', import.meta.url).href;

// Transformers.js file name suffix for each dtype.
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
const COMPONENTS = ['encoder_model', 'decoder_model_merged'];
const RUNTIME = {
  wasm: ['vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm'],
  webgpu: ['vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm'],
};

let manifestPromise = null;

/** @returns {Promise<Array<{id, label, name, description, default, dtype, files, runtime}>>} */
export function listModels() {
  if (!manifestPromise) {
    manifestPromise = fetch(BASE + 'models/models.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error('models.json ' + r.status);
        return r.json();
      })
      .then((m) => m.models.map((model) => ({ ...model, runtime: m.runtime })))
      .catch((err) => {
        manifestPromise = null;
        throw err;
      });
  }
  return manifestPromise;
}

/** dtype per component for a device, e.g. { encoder_model: 'q8', decoder_model_merged: 'q8' } */
export function dtypeFor(model, device) {
  const d = model.dtype[device] || model.dtype.wasm;
  return typeof d === 'string' ? Object.fromEntries(COMPONENTS.map((c) => [c, d])) : d;
}

/** The files (url, size) this device needs for the model. */
export function downloadsFor(model, device) {
  const dtype = dtypeFor(model, device);
  const wanted = COMPONENTS.map((c) => `onnx/${c}${SUFFIX[dtype[c]] ?? ''}.onnx`);
  const files = model.files.filter((f) => !f.path.startsWith('onnx/') || wanted.some((w) => f.path === w || f.path.startsWith(w + '_data')));
  const runtime = RUNTIME[device] || RUNTIME.wasm;
  return [
    ...files.map((f) => ({ url: BASE + 'models/' + model.id + '/' + f.path, size: f.size })),
    ...model.runtime.filter((f) => runtime.includes(f.path)).map((f) => ({ url: BASE + f.path, size: f.size })),
  ];
}

export function bytesFor(model, device) {
  return downloadsFor(model, device).reduce((s, f) => s + f.size, 0);
}

/** How many of the bytes this device needs are already on the phone. */
export async function cachedBytes(model, device) {
  const cache = await caches.open(MODEL_CACHE);
  let bytes = 0;
  for (const f of downloadsFor(model, device)) {
    if (await cache.match(f.url)) bytes += f.size;
  }
  return bytes;
}

export async function isCached(model, device) {
  return (await cachedBytes(model, device)) === bytesFor(model, device);
}

/**
 * Download every file of the model this device needs that isn't cached yet.
 * onProgress({ loaded, total }) in bytes across all files.
 */
export async function downloadModel(model, device, onProgress, signal) {
  const cache = await caches.open(MODEL_CACHE);
  const list = downloadsFor(model, device);
  const total = list.reduce((s, f) => s + f.size, 0);
  let loaded = 0;
  for (const f of list) {
    if (await cache.match(f.url)) {
      loaded += f.size;
      onProgress?.({ loaded, total });
      continue;
    }
    const res = await fetch(f.url, { cache: 'no-store', signal });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${f.url.slice(BASE.length)}`);
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress?.({ loaded: loaded + got, total });
    }
    if (got !== f.size) throw new Error(`Download incomplete: ${f.url.slice(BASE.length)} (${got} of ${f.size} bytes)`);
    const type = res.headers.get('content-type') || 'application/octet-stream';
    try {
      await cache.put(f.url, new Response(new Blob(parts, { type }), { headers: { 'content-type': type, 'content-length': String(got) } }));
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        throw new Error('Not enough storage space on this phone for the speech model. Free up space, or choose the Fast model.');
      }
      throw err;
    }
    loaded += f.size;
    onProgress?.({ loaded, total });
  }
}

/** Remove the model's own files (all versions). The runtime files are shared, so they stay. */
export async function deleteModel(model) {
  const cache = await caches.open(MODEL_CACHE);
  for (const f of model.files) await cache.delete(BASE + 'models/' + model.id + '/' + f.path);
}
