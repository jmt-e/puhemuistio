// Recovery and add-to-note test: start recording, reload the page mid-way
// (as if Safari was killed), continue the saved draft, stop; then add more
// to the note with auto language detection.
//   node tests/e2e-recovery.mjs <first.wav> <second.wav>
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
const [wav1, wav2] = process.argv.slice(2);
const dir = path.dirname(new URL(import.meta.url).pathname);
const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('node', [path.join(dir, 'serve.mjs'), String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 500));

const problems = [];
async function launch(wav, userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`],
    permissions: ['microphone'],
    viewport: { width: 390, height: 844 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  return { ctx, page };
}
const waitDone = (page) => page.waitForFunction(() => document.querySelector('#note-progress').hidden
  && !document.querySelector('#view-note').hidden && !document.querySelector('#note-error').hidden === false
  && document.querySelector('#note-text').value.length > 0, null, { timeout: 600000 });

const profile = path.join(dir, 'output', 'profile-' + port);
const base = `http://localhost:${port}/`;
let { ctx, page } = await launch(wav1, profile);
await page.goto(base);
await page.waitForSelector('#view-list:not([hidden])');
await page.click('#new-note');
await page.fill('#record-title', 'Recovery test');
await page.click('#record-lang [data-lang="fi"]');
await page.click('#btn-record');
await page.waitForTimeout(6000);
// Simulate Safari killing the page: close the browser without stopping.
await ctx.close();

({ ctx, page } = await launch(wav1, profile));
await page.goto(base);
await page.waitForSelector('#draft-banner:not([hidden])');
console.log('banner:', (await page.textContent('#draft-banner')).trim());
await page.click('#draft-banner button');
await page.waitForSelector('#view-record:not([hidden])');
console.log('after reload timer:', await page.textContent('#timer'), 'title:', await page.inputValue('#record-title'));
await page.click('#btn-record'); // continue
await page.waitForTimeout(6000);
await page.click('#btn-stop');
await waitDone(page);
const first = await page.inputValue('#note-text');
console.log('first text:', JSON.stringify(first), 'meta:', await page.textContent('#note-meta'));
await ctx.close();

({ ctx, page } = await launch(wav2, profile));
await page.goto(base);
await page.click('.note-item');
await page.waitForSelector('#view-note:not([hidden])');
await page.click('#note-add');
await page.waitForSelector('#view-record:not([hidden])');
console.log('heading:', await page.textContent('#record-heading'), '|', await page.textContent('#record-append'));
await page.click('#record-lang [data-lang="auto"]');
await page.click('#btn-record');
await page.waitForTimeout(9000);
await page.click('#btn-stop');
await page.waitForFunction((f) => document.querySelector('#note-progress').hidden && document.querySelector('#note-text').value !== f, first, { timeout: 600000 });
const second = await page.inputValue('#note-text');
console.log('after add:', JSON.stringify(second), 'meta:', await page.textContent('#note-meta'));
console.log('starts with first text:', second.startsWith(first));
console.log('problems:', problems.length ? problems : 'none');
await ctx.close();
server.kill();
process.exit(problems.length || !second.startsWith(first) ? 1 : 0);
