#!/usr/bin/env python3
"""Make a test set from Google FLEURS for scripts/eval-wer.mjs.

    python3 scripts/fleurs-testset.py <fi_fi-test.parquet> <out_dir> <n>

The parquet comes from
https://huggingface.co/api/datasets/google/fleurs/parquet/fi_fi/test (en_us
for English). Writes n 16 kHz mono WAVs and set.jsonl, picking utterances
spread across the set, one per sentence. Needs: pip install pyarrow soundfile numpy
"""
import sys, json, io, pathlib
import pyarrow.parquet as pq, soundfile as sf, numpy as np
src, outdir, n = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])
t = pq.read_table(src)
print(t.schema.names)
rows = t.to_pylist()
outdir.mkdir(parents=True, exist_ok=True)
seen = set(); picked = []
step = max(1, len(rows) // (n * 2))
for i in range(0, len(rows), step):
    r = rows[i]
    if r['id'] in seen: continue
    seen.add(r['id']); picked.append(r)
    if len(picked) == n: break
with open(outdir / 'set.jsonl', 'w') as f:
    for k, r in enumerate(picked):
        a = r['audio']
        data, sr = sf.read(io.BytesIO(a['bytes']), dtype='float32')
        if data.ndim > 1: data = data.mean(axis=1)
        assert sr == 16000, sr
        p = outdir / f'{k:04d}.wav'
        sf.write(p, data, 16000, subtype='PCM_16')
        f.write(json.dumps({'audio': str(p), 'text': r['raw_transcription'], 'dur': len(data) / sr}, ensure_ascii=False) + '\n')
print(len(rows), 'rows ->', len(picked), 'picked, total s:', sum(len(sf.read(outdir / f'{k:04d}.wav')[0]) for k in range(len(picked))) / 16000)
