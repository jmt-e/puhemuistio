// Interrupted model download: start downloading the Fast model in Settings,
// kill the browser half-way, reopen the app and check that the download
// continues by itself from the saved pieces and completes.
//   node tests/e2e-download.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
const dir = path.dirname(new URL(import.meta.url).pathname);
const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('node', [path.join(dir, 'serve.mjs'), String(port)], { stdio: 'ignore', env: { ...process.env, THROTTLE_MBPS: '15' } });
await new Promise((r) => setTimeout(r, 500));
const profile = path.join(dir, 'output', 'profile-dl-' + port);
fs.rmSync(profile, { recursive: true, force: true });
const base = `http://localhost:${port}/`;
const errors = [];

async function open() {
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: '/opt/pw-browsers/chromium', viewport: { width: 390, height: 844 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready);
  return { ctx, page };
}
const status = (page) => page.evaluate(() => document.querySelectorAll('.model-card')[1]?.querySelector('.status')?.textContent);

let { ctx, page } = await open();
await page.reload();
await page.goto(base + '#/settings');
await page.waitForSelector('.model-card');
await (await (await page.$$('.model-card'))[1].$('button:has-text("Download")')).click();
await page.waitForFunction(() => /Downloading… ([4-9]\d)%/.test(document.querySelectorAll('.model-card')[1].textContent), null, { timeout: 300000 });
console.log('before kill:', await status(page));
await ctx.close(); // like iOS closing the app mid-download

({ ctx, page } = await open());
await page.waitForSelector('#draft-banner:not([hidden])', { timeout: 30000 });
await page.waitForFunction(() => /Downloading the speech model/.test(document.querySelector('#draft-banner').textContent), null, { timeout: 30000 });
console.log('after reopen, list shows:', (await page.textContent('#draft-banner strong')).trim());
await page.goto(base + '#/settings');
await page.waitForSelector('.model-card');
console.log('resumed at:', await status(page));
await page.waitForFunction(() => document.querySelectorAll('.model-card')[1].textContent.includes('On this phone'), null, { timeout: 300000 });
console.log('finished:', await status(page));
// Read the biggest file back through the piece reader and compare with the original.
const file = 'models/whisper-small/onnx/decoder_model_merged_quantized.onnx_data';
const check = await page.evaluate(async (file) => {
  const { readFile } = await import('./js/model-files.js');
  const stored = new Uint8Array(await (await readFile(new URL(file, location.href).href)).arrayBuffer());
  const original = new Uint8Array(await (await fetch(file + '?nocache=' + Date.now(), { cache: 'no-store' })).arrayBuffer());
  let same = stored.length === original.length;
  for (let i = 0; same && i < stored.length; i += 4093) same = stored[i] === original[i];
  return { stored: stored.length, original: original.length, same };
}, file);
console.log('read back:', check, '| errors:', errors.length ? errors : 'none');
await ctx.close();
server.kill();
process.exit(!check.same || errors.length ? 1 : 0);
