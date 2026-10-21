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

// ---------- what is on the phone ----------
//
// Storage layout in MODEL_CACHE. A file that fits in one piece is stored
// under its own URL. A bigger file is stored as pieces, "<url>?piece=<i>",
// plus a marker "<url>?pieces=<n>&size=<bytes>" written after the last
// piece. Pieces are never joined in storage: Safari's Cache.match() loads a
// whole entry into memory, so joining (or even checking) big entries crashed
// the page. readFile streams the pieces one at a time when the model loads.
// Checks use cache.keys(), which loads no content.

const PIECE = 8 * 1024 * 1024;
const pieceCount = (size) => Math.max(1, Math.ceil(size / PIECE));
const pieceKey = (url, i) => `${url}?piece=${i}`;
const markerKey = (url, n, size) => `${url}?pieces=${n}&size=${size}`;

async function storedKeys() {
  const cache = await caches.open(MODEL_CACHE);
  return new Set((await cache.keys()).map((r) => r.url));
}

function fileState(f, keys) {
  const n = pieceCount(f.size);
  if (keys.has(f.url) || keys.has(markerKey(f.url, n, f.size))) return { complete: true, bytes: f.size };
  let pieces = 0;
  for (let i = 0; i < n; i++) if (keys.has(pieceKey(f.url, i))) pieces++;
  return { complete: false, bytes: Math.min(f.size, pieces * PIECE) };
}

/** How many of the bytes this device needs are on the phone as complete files. */
export async function cachedBytes(model, device) {
  const keys = await storedKeys();
  return downloadsFor(model, device).reduce((s, f) => s + (fileState(f, keys).complete ? f.size : 0), 0);
}

/** Like cachedBytes, but also counts pieces of files still being downloaded. */
export async function savedBytes(model, device) {
  const keys = await storedKeys();
  return downloadsFor(model, device).reduce((s, f) => s + fileState(f, keys).bytes, 0);
}

export async function isCached(model, device) {
  const keys = await storedKeys();
  return downloadsFor(model, device).every((f) => fileState(f, keys).complete);
}

/**
 * A stored file as a Response, or null if it isn't (completely) on the
 * phone. A file stored in pieces is streamed one piece at a time, so only
 * what the reader actually consumes is loaded into memory.
 * (sw.js has a copy of this for the service worker.)
 */
export async function readFile(url) {
  const cache = await caches.open(MODEL_CACHE);
  const keys = (await cache.keys()).map((r) => r.url);
  if (keys.includes(url)) return cache.match(url);
  const marker = keys.find((k) => k.startsWith(url + '?pieces='));
  if (!marker) return null;
  const params = new URL(marker).searchParams;
  const n = Number(params.get('pieces'));
  const size = params.get('size');
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= n) return controller.close();
      const res = await cache.match(pieceKey(url, i++));
      if (!res) return controller.error(new Error('A piece of the speech model is missing; download it again.'));
      controller.enqueue(new Uint8Array(await res.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': size } });
}

/**
 * Download every file of the model this device needs that isn't saved yet.
 * onProgress({ loaded, total }) in bytes across all files; onPiece() after
 * each piece is saved.
 *
 * Files come in 8 MB pieces (HTTP Range requests), each saved as soon as it
 * arrives. If the download stops (screen lock, app closed, network gone),
 * calling this again continues from the last saved piece. iOS doesn't let
 * web apps download while they are closed, so this is the next best thing.
 */
export async function downloadModel(model, device, onProgress, signal, onPiece) {
  const cache = await caches.open(MODEL_CACHE);
  const keys = await storedKeys();
  const list = downloadsFor(model, device);
  const total = list.reduce((s, f) => s + f.size, 0);
  let loaded = 0;
  for (const f of list) {
    if (!fileState(f, keys).complete) {
      await downloadFile(f, cache, keys, (n) => onProgress?.({ loaded: loaded + n, total }), signal, onPiece);
    }
    loaded += f.size;
    onProgress?.({ loaded, total });
  }
}

const name = (f) => f.url.slice(BASE.length);

async function downloadFile(f, cache, keys, onBytes, signal, onPiece) {
  const n = pieceCount(f.size);
  if (n === 1) {
    const piece = await fetchPiece(f, null, onBytes, signal);
    await put(cache, f.url, piece.blob, piece.type);
    onPiece?.();
    return;
  }
  let done = 0;
  for (let i = 0; i < n; i++) {
    const start = i * PIECE;
    const end = Math.min(f.size, start + PIECE) - 1;
    if (!keys.has(pieceKey(f.url, i))) {
      const piece = await fetchPiece(f, [start, end], (b) => onBytes(done + b), signal);
      await put(cache, pieceKey(f.url, i), piece.blob, piece.type);
      onPiece?.();
    }
    done += end - start + 1;
    onBytes(done);
  }
  await put(cache, markerKey(f.url, n, f.size), new Blob([]), 'text/plain');
}

async function put(cache, key, blob, type) {
  try {
    await cache.put(key, new Response(blob, { headers: { 'content-type': type, 'content-length': String(blob.size) } }));
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      throw new Error('Not enough storage space on this phone for the speech model. Free up space, or choose the Fast model.');
    }
    throw err;
  }
}

/** One piece of a file (or the whole file), retrying a few times: phone connections drop. */
async function fetchPiece(f, range, onBytes, signal, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(f.url, { signal, headers: range ? { range: `bytes=${range[0]}-${range[1]}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (range && res.status !== 206) throw new Error('the server does not support resuming');
      const expected = range ? range[1] - range[0] + 1 : f.size;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onBytes(got);
      }
      if (got !== expected) throw new Error(`got ${got} of ${expected} bytes`);
      const type = res.headers.get('content-type') || 'application/octet-stream';
      return { blob: new Blob(parts, { type }), type };
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err;
      if (attempt >= tries) throw new Error(`${name(f)}: ${err.message}`);
      onBytes(0);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Remove the model's own files (all versions, pieces too). The runtime files are shared, so they stay. */
export async function deleteModel(model) {
  const cache = await caches.open(MODEL_CACHE);
  const prefix = BASE + 'models/' + model.id + '/';
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
}

// Pieces from version 0.3.0 lived in a separate cache; they are not reused.
caches.delete('puhemuistio-partial-v1').catch(() => {});
