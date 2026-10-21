// Word error rate of a Whisper model (Transformers.js layout) on a test set
// made by scripts/fleurs-testset.py. Runs in Node with the same Transformers.js
// version and generate() settings as js/engine-worker.js.
//
//   npm install --ignore-scripts @huggingface/transformers@4.3.1   (in a scratch folder)
//   node eval-wer.mjs <modelDir> '{"encoder_model":"q4","decoder_model_merged":"q8"}' fi <set.jsonl> [n]
import { env, AutoProcessor, WhisperForConditionalGeneration } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';

const [modelDir, dtypeJson, lang, setFile, nArg] = process.argv.slice(2);
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = path.dirname(path.resolve(modelDir)) + '/';
const id = path.basename(modelDir);
const dtype = JSON.parse(dtypeJson);

function readWav(file) {
  const b = fs.readFileSync(file);
  // 16-bit mono PCM WAV at 16 kHz (prepared that way); find the data chunk.
  let off = 12;
  while (off < b.length) {
    const tag = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (tag === 'data') {
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function normalize(s) {
  return s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function edits(a, b) {
  const d = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

const items = fs.readFileSync(setFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(0, Number(nArg || 1e9));
const t0 = Date.now();
const processor = await AutoProcessor.from_pretrained(id);
const model = await WhisperForConditionalGeneration.from_pretrained(id, { dtype, device: 'cpu' });
const loadS = (Date.now() - t0) / 1000;

let wE = 0, wN = 0, cE = 0, cN = 0, audioS = 0, procS = 0;
const samples = [];
for (const it of items) {
  const audio = readWav(it.audio);
  audioS += audio.length / 16000;
  const t = Date.now();
  const { input_features } = await processor(audio);
  const out = await model.generate({ inputs: input_features, language: lang === 'fi' ? 'finnish' : 'english', task: 'transcribe', max_new_tokens: 440 });
  const hyp = processor.tokenizer.batch_decode(out, { skip_special_tokens: true })[0].trim();
  procS += (Date.now() - t) / 1000;
  const r = normalize(it.text), h = normalize(hyp);
  const rw = r.split(' '), hw = h ? h.split(' ') : [];
  wE += edits(rw, hw); wN += rw.length;
  cE += edits([...r], [...h]); cN += r.length;
  if (samples.length < 3) samples.push({ ref: it.text, hyp });
}
const res = {
  model: id, dtype, lang, n: items.length,
  wer: +(100 * wE / wN).toFixed(2), cer: +(100 * cE / cN).toFixed(2),
  rtf: +(procS / audioS).toFixed(3), loadS: +loadS.toFixed(1),
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  samples,
};
console.log(JSON.stringify(res));
