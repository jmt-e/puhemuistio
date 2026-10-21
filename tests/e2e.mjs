// End-to-end test in headless Chromium with a fake microphone.
//   node tests/e2e.mjs <audio.wav> [language] [modelId]
// Records the file through the real recording path, stops, waits for the
// transcript, and fails if the page tried to reach any other server or hit a
// Content-Security-Policy violation.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

const [wav, language = 'fi', modelId = ''] = process.argv.slice(2);
const dir = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(dir, 'output');
fs.mkdirSync(out, { recursive: true });
const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('node', [path.join(dir, 'serve.mjs'), String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const problems = [];
const external = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /Content Security Policy|Refused/.test(t)) problems.push(`[${m.type()}] ${t}`);
  else if (process.env.VERBOSE) console.log(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
ctx.on('request', (r) => {
  const u = new URL(r.url());
  if (!['localhost', '127.0.0.1'].includes(u.hostname) && !['blob:', 'data:'].includes(u.protocol)) external.push(r.url());
});
ctx.on('weberror', (e) => problems.push('[weberror] ' + e.error().message));

const base = `http://localhost:${port}/`;
await page.goto(base);
// Second load: the service worker now controls the page (cross-origin isolated).
await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready, null, { timeout: 15000 });
await page.reload();
await page.waitForSelector('#view-list:not([hidden])');
const isolated = await page.evaluate(() => self.crossOriginIsolated);
console.log('crossOriginIsolated:', isolated);
if (modelId) {
  await page.evaluate(async (id) => {
    const db = await import('./js/db.js');
    await db.setSetting('model', id);
  }, modelId);
  await page.reload();
}
await page.screenshot({ path: path.join(out, '1-list.png') });

await page.click('#new-note');
await page.waitForSelector('#view-record:not([hidden])');
await page.fill('#record-title', 'Test customer');
await page.click(`#record-lang [data-lang="${language}"]`);
await page.click('#btn-record');
await page.waitForTimeout(4000);
await page.click('#btn-record'); // pause
await page.waitForTimeout(1500);
const pausedTime = await page.textContent('#timer');
await page.waitForTimeout(1500);
const stillPaused = await page.textContent('#timer');
await page.screenshot({ path: path.join(out, '2-paused.png') });
await page.click('#btn-record'); // continue
await page.waitForTimeout(8000);
await page.screenshot({ path: path.join(out, '3-recording.png') });
await page.click('#btn-stop');
await page.waitForSelector('#view-note:not([hidden])');
const t0 = Date.now();
await page.waitForSelector('#note-progress:not([hidden])', { timeout: 5000 }).catch(() => {});
await page.screenshot({ path: path.join(out, '4-transcribing.png') });
await page.waitForFunction(() => document.querySelector('#note-progress').hidden && document.querySelector('#note-text').value.length > 0
  || !document.querySelector('#note-error').hidden, null, { timeout: 600000 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const text = await page.inputValue('#note-text');
const err = await page.evaluate(() => { const e = document.querySelector('#note-error'); return e.hidden ? null : e.textContent; });
await page.screenshot({ path: path.join(out, '5-note.png'), fullPage: true });

console.log('timer at pause:', pausedTime, 'after 1.5 s more:', stillPaused);
console.log(`transcribed in ${secs}s:`, JSON.stringify(text));
if (err) console.log('ERROR BOX:', err);
console.log('device:', await page.evaluate(async () => (await import('./js/engine.js')).currentDevice()));
await page.click('#note-back');
await page.waitForSelector('#view-list:not([hidden])');
await page.screenshot({ path: path.join(out, '6-list.png') });

console.log('external requests:', external.length ? external : 'none');
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
server.kill();
process.exit(external.length || problems.length || err || pausedTime !== stillPaused ? 1 : 0);
