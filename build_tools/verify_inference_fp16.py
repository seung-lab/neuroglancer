#!/usr/bin/env python3
"""Validate browser FP16 output against independent ONNX/NumPy/ORT conversion.

Usage: python build_tools/verify_inference_fp16.py ORIGINAL.onnx BROWSER.onnx
Requires onnx, numpy, onnxruntime (including its transformers.float16 module).
No files are modified. Runs full checker + strict shape inference, compares ALL
weights/shape tensors, attributes, public and interior shapes/types, graph nodes,
and CPU outputs against an independent Python conversion (not just FP32 output).
CPU uses deterministic bounded inputs; this is not a GPU or accuracy benchmark.
"""

import argparse
import copy
import hashlib
import json

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.transformers.float16 import convert_float_to_float16

ORIGINALS = {
    "0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860",
    "2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c",
}


def tensor_pairs(source, target):
    assert len(source.graph.initializer) == len(target.graph.initializer)
    yield from zip(source.graph.initializer, target.graph.initializer)
    # Boundary Casts are the only added nodes.
    assert len(target.graph.node) == len(source.graph.node) + 2
    for old, new in zip(source.graph.node, target.graph.node[1:-1]):
        assert len(old.attribute) == len(new.attribute)
        for a, b in zip(old.attribute, new.attribute):
            if a.HasField("t"):
                yield a.t, b.t
            assert len(a.tensors) == len(b.tensors)
            yield from zip(a.tensors, b.tensors)


def reference_model(source):
    # Independent established converter handles types and boundary wiring. Its
    # default weight clamps are NOT the desired semantics: replace every tensor
    # from the original via NumPy, then verify every resulting byte separately.
    ref = convert_float_to_float16(
        copy.deepcopy(source),
        keep_io_types=True,
        op_block_list=[],
        node_block_list=[],
        force_fp16_initializers=True,
    )
    casts = [n for n in ref.graph.node if n.name.startswith("graph_input_cast")]
    for n in casts:
        ref.graph.node.remove(n)
    for n in reversed(casts):
        ref.graph.node.insert(0, n)
    for old, new in tensor_pairs(source, ref):
        if old.data_type != onnx.TensorProto.FLOAT:
            new.CopyFrom(old)
            continue
        values = onnx.numpy_helper.to_array(old)
        with np.errstate(over="raise", invalid="raise"):
            converted = values.astype(np.float16)
        assert np.isfinite(converted).all()
        new.CopyFrom(old)
        new.data_type = onnx.TensorProto.FLOAT16
        new.ClearField("float_data")
        new.ClearField("int32_data")
        new.raw_data = converted.astype("<f2").tobytes()
    return ref


def shape_map(model):
    return {
        v.name: v.type.SerializeToString()
        for v in list(model.graph.input)
        + list(model.graph.output)
        + list(model.graph.value_info)
    }


def verify(original_path, browser_path):
    with open(original_path, "rb") as f:
        original_bytes = f.read()
    assert hashlib.sha256(original_bytes).hexdigest() in ORIGINALS, "not a supported original"
    original = onnx.load_model_from_string(original_bytes)
    actual = onnx.load(browser_path, load_external_data=False)
    expected = reference_model(original)
    for model in (actual, expected):
        onnx.checker.check_model(model, full_check=True)
    actual_inferred = onnx.shape_inference.infer_shapes(actual, strict_mode=True)
    expected_inferred = onnx.shape_inference.infer_shapes(expected, strict_mode=True)
    original_inferred = onnx.shape_inference.infer_shapes(original, strict_mode=True)
    assert shape_map(actual_inferred) == shape_map(expected_inferred), "interior shape/type mismatch"
    # Also compare spatial dimensions directly to original inferred values;
    # neither conversion may silently change rank, dimensions, or layout.
    actual_shapes = shape_map(actual_inferred)
    for old in list(original_inferred.graph.input) + list(original_inferred.graph.output) + list(original_inferred.graph.value_info):
        name = {"input": "graph_input_cast_0", "output": "graph_output_cast_0"}.get(old.name, old.name)
        typ = onnx.TypeProto.FromString(actual_shapes[name])
        assert typ.tensor_type.shape == old.type.tensor_type.shape
    for old, new in zip(original.graph.input, actual.graph.input):
        assert old.SerializeToString() == new.SerializeToString(), "public input changed"
    for old, new in zip(original.graph.output, actual.graph.output):
        assert old.SerializeToString() == new.SerializeToString(), "public output changed"
    float_elements = 0
    float_tensors = 0
    nonfloat_tensors = 0
    for old, new in tensor_pairs(original, actual):
        if old.data_type != onnx.TensorProto.FLOAT:
            assert old.SerializeToString() == new.SerializeToString(), "integer/shape tensor changed"
            nonfloat_tensors += 1
            continue
        float_tensors += 1
        values = onnx.numpy_helper.to_array(old)
        with np.errstate(over="raise", invalid="raise"):
            fp16 = values.astype("<f2")
        assert new.data_type == onnx.TensorProto.FLOAT16
        assert new.raw_data == fp16.tobytes(), f"NumPy mismatch: {old.name}"
        # All tensor metadata except dtype/payload must survive.
        restored = copy.deepcopy(old)
        restored.data_type = onnx.TensorProto.FLOAT16
        restored.ClearField("float_data")
        restored.raw_data = fp16.tobytes()
        assert restored.SerializeToString() == new.SerializeToString(), "tensor metadata changed"
        float_elements += values.size
    # The independent converter may add inferred value_info. Compare separately
    # via inference above rather than requiring incidental protobuf field order.
    for key in ("node", "initializer", "input", "output"):
        assert list(getattr(actual.graph, key)) == list(getattr(expected.graph, key)), key
    stripped_actual, stripped_expected = copy.deepcopy(actual), copy.deepcopy(expected)
    for model in (stripped_actual, stripped_expected):
        model.graph.ClearField("value_info")
    assert stripped_actual == stripped_expected, "non-value graph/model metadata changed"
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    providers = ["CPUExecutionProvider"]
    sessions = [
        ort.InferenceSession(m.SerializeToString(), sess_options=options, providers=providers)
        for m in (actual, expected, original)
    ]
    shape = [d.dim_value for d in original.graph.input[0].type.tensor_type.shape.dim]
    rng = np.random.default_rng(20260602)
    comparisons = []
    for values in (rng.uniform(0, 1, shape).astype(np.float32), np.full(shape, 0.25, np.float32)):
        outputs = [s.run(None, {original.graph.input[0].name: values}) for s in sessions]
        metrics = []
        for actual_output, expected_output, fp32 in zip(*outputs):
            assert actual_output.dtype == np.float32
            assert np.isfinite(actual_output).all(), "CPU FP16 produced nonfinite output"
            assert expected_output.dtype == np.float32
            np.testing.assert_array_equal(
                actual_output.view(np.uint32), expected_output.view(np.uint32)
            )
            difference = np.abs(actual_output.astype(np.float64) - fp32)
            metrics.append({"max_abs_vs_fp32": float(difference.max()), "mean_abs_vs_fp32": float(difference.mean())})
        comparisons.append(metrics)
    print(json.dumps({
        "status": "passed",
        "full_onnx_checker": True,
        "strict_shape_inference": True,
        "original_nodes": len(original.graph.node),
        "converted_nodes": len(actual.graph.node),
        "float_tensors": float_tensors,
        "float_elements": float_elements,
        "nonfloat_tensors_bitexact": nonfloat_tensors,
        "cpu_inputs": len(comparisons),
        "cpu_reference": "bit-exact independent Python FP16",
        "fp32_diagnostics": comparisons,
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original")
    parser.add_argument("browser")
    args = parser.parse_args()
    verify(args.original, args.browser)
