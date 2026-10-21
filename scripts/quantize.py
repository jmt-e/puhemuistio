#!/usr/bin/env python3
"""Quantize a Whisper ONNX export into the files Transformers.js loads.

    python3 scripts/quantize.py <onnx_dir> <out_dir> q8 [q4]

<onnx_dir> is an Optimum export (encoder_model.onnx, decoder_model_merged.onnx
and the JSON configs). Writes <name>_quantized.onnx (q8: int8 MatMul and
Gather, dynamic quantization) and/or <name>_q4.onnx (q4: 4-bit MatMulNBits,
block 32, plus int8 Gather) for the encoder and the merged decoder.
See models/README.md for the full recipe. Needs: pip install onnx onnxruntime
"""
import sys, os, shutil, pathlib, onnx
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig

src, out, kinds = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3:]
(out / 'onnx').mkdir(parents=True, exist_ok=True)
for f in src.iterdir():
    if f.suffix in ('.json', '.txt'):
        shutil.copy(f, out / f.name)
for name in ['encoder_model', 'decoder_model_merged']:
    model_path = src / f'{name}.onnx'
    if 'q8' in kinds:
        dst = out / 'onnx' / f'{name}_quantized.onnx'
        quantize_dynamic(str(model_path), str(dst), weight_type=QuantType.QInt8, per_channel=False,
                         reduce_range=False, op_types_to_quantize=['MatMul', 'Gather'],
                         extra_options={'EnableSubgraph': True}, use_external_data_format=False)
        print(dst, os.path.getsize(dst) // 1_000_000, 'MB', flush=True)
    if 'q4' in kinds:
        dst = out / 'onnx' / f'{name}_q4.onnx'
        m = onnx.load(str(model_path))
        q = MatMulNBitsQuantizer(m, block_size=32, is_symmetric=True, accuracy_level=4,
                                 algo_config=DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, accuracy_level=4))
        q.process()
        tmp = str(dst) + '.tmp.onnx'
        onnx.save_model(q.model.model, tmp)
        # The token embedding (Gather) is the biggest weight MatMulNBits
        # leaves alone: store it as int8 too.
        quantize_dynamic(tmp, str(dst), weight_type=QuantType.QInt8, per_channel=False,
                         op_types_to_quantize=['Gather'], extra_options={'EnableSubgraph': True})
        os.remove(tmp)
        print(dst, os.path.getsize(dst) // 1_000_000, 'MB', flush=True)
