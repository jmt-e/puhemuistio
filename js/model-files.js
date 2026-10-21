// Model files: the list of models (models/models.json), and downloading them
// from this site into the phone's Cache Storage so speech recognition works
// offline. A model's download includes the ONNX Runtime files that run it.
// Shared by the page and the engine worker.

export const MODEL_CACHE = 'puhemuistio-models-v1';

const BASE = new URL('../', import.meta.url).href;

let manifestPromise = null;

/**
 * @returns {Promise<Array<{id, label, name, description, default, dtype,
 *   downloads: Array<{url, size}>, bytes}>>}
 */
export function listModels() {
  if (!manifestPromise) {
    manifestPromise = fetch(BASE + 'models/models.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error('models.json ' + r.status);
        return r.json();
      })
      .then((m) => m.models.map((model) => {
        const downloads = [
          ...model.files.map((f) => ({ url: BASE + 'models/' + model.id + '/' + f.path, size: f.size })),
          ...m.runtime.map((f) => ({ url: BASE + f.path, size: f.size })),
        ];
        return { ...model, downloads, bytes: downloads.reduce((s, f) => s + f.size, 0) };
      }))
      .catch((err) => {
        manifestPromise = null;
        throw err;
      });
  }
  return manifestPromise;
}

/** How many of the model's bytes are already on the phone. */
export async function cachedBytes(model) {
  const cache = await caches.open(MODEL_CACHE);
  let bytes = 0;
  for (const f of model.downloads) {
    if (await cache.match(f.url)) bytes += f.size;
  }
  return bytes;
}

export async function isCached(model) {
  return (await cachedBytes(model)) === model.bytes;
}

/**
 * Download every file of the model that isn't cached yet.
 * onProgress({ loaded, total }) in bytes across all files.
 */
export async function downloadModel(model, onProgress, signal) {
  const cache = await caches.open(MODEL_CACHE);
  let loaded = 0;
  const total = model.bytes;
  for (const f of model.downloads) {
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
    await cache.put(f.url, new Response(new Blob(parts, { type }), { headers: { 'content-type': type, 'content-length': String(got) } }));
    loaded += f.size;
    onProgress?.({ loaded, total });
  }
}

/** Remove the model's own files. The runtime files are shared, so they stay. */
export async function deleteModel(model) {
  const cache = await caches.open(MODEL_CACHE);
  const prefix = BASE + 'models/' + model.id + '/';
  for (const f of model.downloads) {
    if (f.url.startsWith(prefix)) await cache.delete(f.url);
  }
}
