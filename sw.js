// Service worker: makes the app work offline, and adds the security headers
// GitHub Pages can't send.
//
// - App files are served from the cache and refreshed in the background.
//   Bump VERSION when releasing so old caches are cleaned up.
// - Model and runtime files are served from the cache the app fills when
//   you download a model (see js/model-files.js).
// - Every response gets a Content-Security-Policy that only allows this
//   site, plus the two headers that make the page "cross-origin isolated",
//   which lets the speech model use several CPU cores.
// - Requests to any other server are refused here too.

const VERSION = 'v6';
const SHELL_CACHE = 'puhemuistio-shell-' + VERSION;
const MODEL_CACHE = 'puhemuistio-models-v1'; // same name as in js/model-files.js

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/engine.js',
  'js/engine-worker.js',
  'js/model-files.js',
  'js/recorder.js',
  'js/pcm-worklet.js',
  'js/share.js',
  'js/changelog.js',
  'js/backup.js',
  'vendor/transformers/transformers.min.js',
  'models/models.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('puhemuistio-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function withHeaders(res) {
  // Opaque or error responses can't be rewrapped usefully.
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const scopeUrl = new URL(self.registration.scope);
const isModelOrRuntime = (url) => url.pathname.startsWith(scopeUrl.pathname + 'models/') && !url.pathname.endsWith('/models.json')
  || url.pathname.startsWith(scopeUrl.pathname + 'vendor/ort/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    // Nothing in this app talks to other servers. Refuse rather than pass through.
    event.respondWith(new Response('Blocked by Puhemuistio: no connections to other servers.', { status: 403 }));
    return;
  }
  if (req.method !== 'GET') return;

  if (isModelOrRuntime(url)) {
    event.respondWith((async () => {
      const plain = url.origin + url.pathname;
      const hit = await caches.match(plain);
      if (hit) return withHeaders(hit);
      // A fresh request, not the page's own: Safari fails ("Load failed")
      // when a service worker re-sends a request that carries the page's
      // cache mode and abort signal.
      // Pass a Range header through: resumed downloads ask for the rest of a file.
      const range = req.headers.get('range');
      const res = await fetch(plain, { credentials: 'same-origin', headers: range ? { range } : {} });
      // Runtime files are small enough to keep as soon as they're used once.
      if (res.status === 200 && url.pathname.includes('/vendor/ort/')) {
        const cache = await caches.open(MODEL_CACHE);
        await cache.put(plain, res.clone());
      }
      return withHeaders(res);
    })());
    return;
  }

  // App files: cache first, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const key = req.mode === 'navigate' ? new Request(new URL('index.html', self.registration.scope)) : req;
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req.mode === 'navigate' ? key : req, { cache: 'no-cache' })
      .then(async (res) => {
        if (res.ok && res.type === 'basic') await cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return withHeaders(cached);
    }
    const res = await network;
    return withHeaders(res || new Response('Offline, and this file is not cached yet.', { status: 503 }));
  })());
});
