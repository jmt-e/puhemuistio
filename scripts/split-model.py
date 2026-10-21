#!/usr/bin/env python3
"""Split an ONNX model's weights into files under GitHub's 100 MB limit.

    python3 scripts/split-model.py models/<id>/onnx/encoder_model_q4.onnx [max_mb]

Rewrites the model so its weights live in external data files named the way
Transformers.js loads them: <file>.onnx_data, <file>.onnx_data_1, ... and
records the chunk count in models/<id>/config.json under
"transformers.js_config" -> "use_external_data_format". Needs the `onnx`
Python package (pip install onnx).
"""
import json
import os
import pathlib
import sys

import onnx
from onnx.external_data_helper import _get_all_tensors, set_external_data, uses_external_data

path = pathlib.Path(sys.argv[1])
max_bytes = int(float(sys.argv[2]) * 1_000_000) if len(sys.argv) > 2 else 90_000_000
model = onnx.load(str(path))  # loads any existing external data too

chunks = []  # list of (name, bytearray)
small_limit = 1024  # tiny tensors stay inside the .onnx file

def chunk_name(i):
    return f"{path.name}_data" + ("" if i == 0 else f"_{i}")

for tensor in _get_all_tensors(model):
    if not tensor.HasField("raw_data") or len(tensor.raw_data) < small_limit:
        continue
    data = tensor.raw_data
    if len(data) > max_bytes:
        raise SystemExit(f"tensor {tensor.name} alone is {len(data)} bytes, over the limit")
    if not chunks or len(chunks[-1][1]) + len(data) > max_bytes:
        chunks.append((chunk_name(len(chunks)), bytearray()))
    name, buf = chunks[-1]
    # Keep offsets aligned for faster mapping.
    pad = (-len(buf)) % 64
    buf.extend(b"\0" * pad)
    set_external_data(tensor, location=name, offset=len(buf), length=len(data))
    buf.extend(data)
    tensor.ClearField("raw_data")
    tensor.data_location = onnx.TensorProto.EXTERNAL

# Remove old data files for this model, then write the new ones.
for old in path.parent.glob(path.name + "_data*"):
    old.unlink()
for name, buf in chunks:
    (path.parent / name).write_bytes(buf)
onnx.save_model(model, str(path), save_as_external_data=False)

config_path = path.parent.parent / "config.json"
config = json.loads(config_path.read_text())
tjs = config.setdefault("transformers.js_config", {})
ext = tjs.setdefault("use_external_data_format", {})
ext[path.name] = len(chunks)
config_path.write_text(json.dumps(config, indent=2) + "\n")

print(f"{path.name}: {os.path.getsize(path) // 1000} kB graph + {len(chunks)} data files "
      f"({', '.join(str(len(b) // 1_000_000) + ' MB' for _, b in chunks)})")
