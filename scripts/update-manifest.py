#!/usr/bin/env python3
"""Refresh the file lists and sizes in models/models.json.

Edit the descriptive fields (label, name, description, dtype, default) by
hand; this script fills in "files" for each model from what is actually in
models/<id>/, and "runtime" from vendor/ort/. Run it after adding, removing
or re-quantising model files, then bump VERSION in sw.js.

    python3 scripts/update-manifest.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "models" / "models.json"
RUNTIME = [
    "vendor/ort/ort-wasm-simd-threaded.mjs",
    "vendor/ort/ort-wasm-simd-threaded.wasm",
    "vendor/ort/ort-wasm-simd-threaded.asyncify.mjs",
    "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm",
]
LIMIT = 100 * 1000 * 1000  # GitHub refuses files over 100 MB

data = json.loads(MANIFEST.read_text())
for model in data["models"]:
    d = ROOT / "models" / model["id"]
    files = []
    for p in sorted(d.rglob("*")):
        if p.is_file() and not p.name.startswith(".") and p.name not in ("README.md", "LICENSE"):
            size = p.stat().st_size
            if size >= LIMIT:
                raise SystemExit(f"{p} is {size} bytes, over GitHub's 100 MB limit")
            files.append({"path": p.relative_to(d).as_posix(), "size": size})
    model["files"] = files
    print(f"{model['id']}: {len(files)} files, {sum(f['size'] for f in files) / 1e6:.1f} MB")
data["runtime"] = [{"path": p, "size": (ROOT / p).stat().st_size} for p in RUNTIME]
MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
