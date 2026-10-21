#!/usr/bin/env python3
"""Store Whisper's tied embedding once instead of twice.

    python3 scripts/dedupe-tied.py <decoder_model_merged_quantized.onnx>

Whisper's decoder uses the same matrix for its token embedding (a Gather on
a [vocab, dim] table) and its output layer (a MatMul with the [dim, vocab]
transpose). The ONNX export stores both, and dynamic quantization keeps two
8-bit copies (uint8 for the Gather, int8 for the MatMul): 40 MB (small) to
53 MB (medium) of duplicate download.

This drops the Gather's copy. The Gather reads Transpose(int8 MatMul weight)
instead, dequantized with the MatMul weight's scale and zero point. ONNX
Runtime folds the Transpose into a constant when the model loads. The result
is checked: the dequantized tables must agree to within one quantization step.

Run it on a single-file 8-bit model, before scripts/split-model.py.
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper

path = sys.argv[1]
model = onnx.load(path)
g = model.graph
inits = {i.name: i for i in g.initializer}


def all_nodes(graph):
    for n in graph.node:
        yield n
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH:
                yield from all_nodes(a.g)


nodes = list(all_nodes(g))
gathers = [n for n in nodes if n.op_type == "Gather" and n.input[0] in inits and len(inits[n.input[0]].dims) == 2]
matmuls = [n for n in nodes if n.op_type == "MatMulInteger" and n.input[1] in inits and len(inits[n.input[1]].dims) == 2]

E_name = next(n.input[0] for n in gathers if inits[n.input[0]].dims[0] > 10_000)
E_dims = list(inits[E_name].dims)
W_name = next(n.input[1] for n in matmuls if list(inits[n.input[1]].dims) == E_dims[::-1])
W_zp_name = next(n.input[3] for n in matmuls if n.input[1] == W_name)

# The Gather's DequantizeLinear nodes, and the MatMul weight's scale.
deq = [n for n in nodes if n.op_type == "DequantizeLinear" and any(
    gn.output[0] == n.input[0] for gn in gathers if gn.input[0] == E_name)]
base = W_name[: -len("_quantized")] if W_name.endswith("_quantized") else W_name
W_scale_name = base + "_scale"
assert W_scale_name in inits, f"no scale initializer {W_scale_name}"
E_scale_name, E_zp_name = deq[0].input[1], deq[0].input[2]

# Check equivalence on the dequantized values.
arr = lambda n: numpy_helper.to_array(inits[n]).astype(np.float32)
E = (arr(E_name) - arr(E_zp_name)) * arr(E_scale_name)
W = (arr(W_name) - arr(W_zp_name)) * arr(W_scale_name)
diff = np.abs(E - W.T).max()
step = max(float(arr(E_scale_name)), float(arr(W_scale_name)))
print(f"tables: {E_name} {E_dims} vs {W_name}; max difference {diff:.5f}, quantization step {step:.5f}")
assert diff <= 1.01 * step, "tables are not the same matrix"

tied = E_name + "_tied"
g.node.insert(0, helper.make_node("Transpose", [W_name], [tied], name="tied_embedding_transpose", perm=[1, 0]))
for n in nodes:
    if n.op_type == "Gather" and n.input[0] == E_name:
        n.input[0] = tied
for n in deq:
    n.input[1] = W_scale_name
    n.input[2] = W_zp_name
saved = 0
for name in (E_name, E_scale_name, E_zp_name):
    if not any(name in n.input for n in all_nodes(g)):
        saved += len(inits[name].raw_data)
        g.initializer.remove(inits[name])
onnx.save_model(model, path)
print(f"saved {saved // 1_000_000} MB")
