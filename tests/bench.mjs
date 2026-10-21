// Speed of the real engine (WASM in Chromium) on a WAV file, bypassing the mic.
//   node tests/bench.mjs <audio16k.wav> <modelId> <fi|en|auto> [wasm|auto]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
const [wav, modelId, language = 'fi', device = 'wasm'] = process.argv.slice(2);
const dir = path.dirname(new URL(import.meta.url).pathname);
const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('node', [path.join(dir, 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

const b = fs.readFileSync(wav);
const dataAt = b.indexOf('data') + 8;
const pcm = Array.from(new Int16Array(b.buffer, b.byteOffset + dataAt, (b.length - dataAt) >> 1));

// WEBGPU=1: software WebGPU (SwiftShader) to check the GPU code path works; it is not a speed test.
const gpuArgs = process.env.WEBGPU ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] : [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: gpuArgs });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready);
await page.reload();
await page.waitForSelector('#view-list:not([hidden])');
const res = await page.evaluate(async ({ pcm, modelId, language, device }) => {
  const engine = await import('./js/engine.js');
  engine.setDevicePreference(device);
  const audio = Float32Array.from(pcm, (v) => v / 32768);
  const run = async () => {
    const t = performance.now();
    const r = await engine.transcribe(audio, { modelId, language });
    return { s: (performance.now() - t) / 1000, text: r.text };
  };
  const first = await run(); // includes download + load
  const second = await run(); // model already loaded
  return { device: await engine.currentDevice(), isolated: self.crossOriginIsolated, firstS: first.s, secondS: second.s, audioS: audio.length / 16000, text: second.text };
}, { pcm, modelId, language, device });
console.log(JSON.stringify({ modelId, ...res, rtf: +(res.secondS / res.audioS).toFixed(3), text: res.text.slice(0, 200) }));
await browser.close();
server.kill();
