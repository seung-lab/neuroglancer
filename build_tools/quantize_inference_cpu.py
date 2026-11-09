#!/usr/bin/env python3
"""One-pass offline CPU/WASM PTQ from original FP32 and a local 16+4 manifest.

No downloads, runtime changes, or quantized-CPU quality benchmark. Quality must
be checked separately in browser WASM. Requires numpy, onnx and onnxruntime.
The output's adjacent .json records provenance; work files are never reused.
"""

import argparse
import hashlib
import json
import platform
import tempfile
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quant_pre_process,
    quantize_static,
)

if __package__:
    from . import inference_cpu_polyphase as polyphase
else:
    import inference_cpu_polyphase as polyphase

OP_TYPES = ["Conv", "ConvTranspose", "Add", "Relu", "MaxPool"]
NORMALIZATION = "float32(uint8) / float32(255)"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def public_io(model):
    return [[v.SerializeToString() for v in values] for values in (model.graph.input, model.graph.output)]


def values(model):
    return {v.name: v.type.tensor_type for v in [*model.graph.input, *model.graph.output, *model.graph.value_info]}


def static_shape(value):
    shape = [d.dim_value for d in value.shape.dim]
    require(len(shape) == 5 and all(d > 0 for d in shape), "Expected positive static NCDHW shape")
    return shape


def validate_manifest(model_path, manifest_path, model):
    """Verify BOTH splits, including byte hashes, normalization and spatial isolation."""
    manifest_path = Path(manifest_path)
    data = json.loads(manifest_path.read_text())
    require(data.get("model_sha256") == sha256(model_path), "Manifest model_sha256 mismatch or missing")
    require(data.get("normalization") == NORMALIZATION, "Unsupported normalization")
    require(data.get("input_layout") == "NCDHW (ZYX spatial)", "Unsupported input_layout")
    require(data.get("resolution_xyz_nm") == [16, 16, 45] and data.get("scale") == "16_16_45", "Expected native 16_16_45 data")
    require(len(model.graph.input) == 1, "Expected one public input")
    shape = static_shape(model.graph.input[0].type.tensor_type)
    require(shape[:2] == [1, 1], "Expected single-channel calibration input")
    xyz = shape[:1:-1]
    require(data.get("shape_xyz") == xyz, "Manifest shape_xyz mismatch")
    require(len(data.get("calibration", [])) == 16 and len(data.get("validation", [])) == 4, "Expected 16 calibration and four held-out samples")
    records = [*data["calibration"], *data["validation"]]
    for item in records:
        lower, upper = item.get("lower_xyz", []), item.get("upper_xyz_exclusive", [])
        require(len(lower) == len(upper) == 3 and all(type(v) is int for v in [*lower, *upper]), "Missing/integer XYZ bounds required")
        require([b-a for a, b in zip(lower, upper)] == xyz, "XYZ bounds disagree with shape")
        for key, hash_key in (("path", "sha256"), ("raw_path", "raw_sha256")):
            path = manifest_path.parent / item[key]
            require(item.get(hash_key) == sha256(path), f"Missing or mismatched {hash_key}: {path}")
        raw = np.load(manifest_path.parent / item["raw_path"], allow_pickle=False)
        normalized = np.load(manifest_path.parent / item["path"], allow_pickle=False)
        require(raw.dtype == np.uint8 and list(raw.shape) == [*xyz, 1], "Expected raw XYZ1 uint8 (explicit singleton channel)")
        require(normalized.dtype == np.float32 and list(normalized.shape) == shape, "Expected normalized float32 NCDHW")
        expected = raw[..., 0].transpose(2, 1, 0)[None, None].astype(np.float32) / np.float32(255)
        require(np.array_equal(normalized, expected), "Wrong normalization or XYZ-to-NCDHW layout")
    for a, b in combinations(records, 2):
        overlap = all(max(x, y) < min(u, v) for x, y, u, v in zip(a["lower_xyz"], b["lower_xyz"], a["upper_xyz_exclusive"], b["upper_xyz_exclusive"]))
        require(not overlap, "Calibration/held-out samples must be spatially disjoint")
    return data


class Reader(CalibrationDataReader):
    def __init__(self, input_name, paths):
        self.input_name, self.paths = input_name, list(paths)
        self.used = Counter()
        self.set_range(0, len(self))

    def __len__(self):
        return len(self.paths)

    def set_range(self, start_index, end_index):
        require(0 <= start_index <= end_index <= len(self), "Invalid reader range")
        self.index, self.end = start_index, end_index

    def get_next(self):
        if self.index == self.end:
            return None
        index = self.index
        self.index += 1
        self.used[index] += 1
        return {self.input_name: np.load(self.paths[index], allow_pickle=False)}


def geometry(node, shape, weight):
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    expected = dict(group=shape[1], kernel_shape=[1, 4, 4], strides=[1, 2, 2], pads=[0, 1, 1, 0, 1, 1], dilations=[1, 1, 1], output_padding=[0, 0, 0], auto_pad=b"NOTSET")
    require(len(node.input) == 2 and len(node.output) == 1 and set(attrs) <= set(expected) and all(attrs.get(k, v) == v for k, v in expected.items()) and attrs.get("group", 1) == shape[1] and attrs.get("strides", [1, 1, 1]) == [1, 2, 2] and attrs.get("pads", [0]*6) == expected["pads"] and weight.shape == (shape[1], 1, 1, 4, 4), f"Unsupported ConvTranspose geometry: {node.name}")


def quantize_qdq(model_path, reader, work_dir):
    """All CT activation ranges and other selected ops share ONE Percentile pass."""
    work_dir = Path(work_dir)
    preprocessed, output = work_dir / "preprocessed.onnx", work_dir / "qdq.onnx"
    # Static NCDHW needs standard ONNX inference only, not optional sympy.
    quant_pre_process(model_path, preprocessed, skip_optimization=True, skip_symbolic_shape=True)
    model = onnx.load(preprocessed)
    arrays = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    types = values(model)
    overrides = {}
    for node in model.graph.node:
        if node.op_type != "ConvTranspose":
            continue
        weight = arrays[node.input[1]]
        geometry(node, static_shape(types[node.input[0]]), weight)
        _, scales = polyphase.lossless_power_of_two_weights(weight)
        # ORT defaults CT to axis 1, which is wrong for these depthwise weights.
        overrides[node.input[1]] = [dict(scale=np.array(s, np.float32), zero_point=np.array(0, np.int8)) for s in scales]
        overrides[node.input[1]][0]["axis"] = 0
    extra = dict(WeightSymmetric=True, ActivationSymmetric=False, CalibPercentile=99.99, CalibStridedMinMax=1, TensorQuantOverrides=overrides)
    quantize_static(preprocessed, output, reader, quant_format=QuantFormat.QDQ, per_channel=True, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, op_types_to_quantize=OP_TYPES, calibrate_method=CalibrationMethod.Percentile, calibration_providers=["CPUExecutionProvider"], extra_options=extra)
    require(reader.used == Counter({i: 1 for i in range(len(reader))}), "Calibration did not consume every sample exactly once")
    config = dict(preprocess={"skip_optimization": True, "skip_symbolic_shape": True}, quant_format="QDQ", per_channel=True, activation_type="QUInt8", weight_type="QInt8", reduce_range=False, op_types_to_quantize=OP_TYPES, calibrate_method="Percentile", calibration_providers=["CPUExecutionProvider"], extra_options=extra)
    return onnx.load(output), config


def lower_conv_transposes(model, original, expected_count=3):
    """Replace XDQ -> CT(WDQ) -> YQ, preserving shared DQs and all other nodes."""
    model = onnx.shape_inference.infer_shapes(model, strict_mode=True)
    nodes, types = list(model.graph.node), values(model)
    arrays = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    originals = {t.name: numpy_helper.to_array(t) for t in original.graph.initializer}
    original_cts = {n.name: n for n in original.graph.node if n.op_type == "ConvTranspose"}
    producers = {name: i for i, n in enumerate(nodes) for name in n.output}
    consumers = defaultdict(list)
    for i, n in enumerate(nodes):
        for name in set(n.input):
            consumers[name].append(i)
    public_outputs = {v.name for v in model.graph.output}
    all_names = set(producers) | set(arrays) | set(consumers) | {n.name for n in nodes}
    replacements, removed, constants, layers = {}, set(), [], []
    generated_outputs = []
    for i, node in enumerate(nodes):
        if node.op_type != "ConvTranspose":
            continue
        shape = static_shape(types[node.input[0]])
        dq_indices = [producers.get(name) for name in node.input[:2]]
        require(len(dq_indices) == 2 and all(j is not None and nodes[j].op_type == "DequantizeLinear" and len(nodes[j].input) == 3 for j in dq_indices), "Expected explicit input/weight DequantizeLinear")
        xdq, wdq = [nodes[j] for j in dq_indices]
        q_indices = consumers[node.output[0]]
        require(len(q_indices) == 1 and node.output[0] not in public_outputs and nodes[q_indices[0]].op_type == "QuantizeLinear", "Expected exactly one output QuantizeLinear")
        yq = nodes[q_indices[0]]
        require(len(yq.input) == 3, "Missing output quantization parameters")
        weight, ws, wz = [arrays[name] for name in wdq.input]
        axis = next((a.i for a in wdq.attribute if a.name == "axis"), 1)
        require(axis in (0, 1) and weight.dtype == np.int8 and ws.dtype == np.float32 and ws.shape == wz.shape and ws.shape == (weight.shape[axis],) and wz.dtype == np.int8 and not np.any(wz), "Expected symmetric axis-0/1 INT8 weight DQ")
        geometry(node, shape, weight)
        broadcast = [1]*5
        broadcast[axis] = weight.shape[axis]
        restored = weight.astype(np.float32) * ws.reshape(broadcast)
        old = original_cts.get(node.name)
        require(old is not None and np.array_equal(restored, originals[old.input[1]]), "ConvTranspose weights are not lossless original weights")
        require(types[xdq.input[0]].elem_type == TensorProto.UINT8, "Expected existing UINT8 activation input")
        xs, xz = [arrays[name] for name in xdq.input[1:]]
        ys, yz = [arrays[name] for name in yq.input[1:]]
        prefix = f"cpu_polyphase{len(layers)}/"
        require(not any(name.startswith(prefix) for name in all_names), "Replacement prefix collision")
        per_channel_scale = np.broadcast_to(ws, (shape[1],)).copy()
        replacement, tensors = polyphase.replacement_nodes(input_name=xdq.input[0], output_name=yq.output[0], input_shape=shape, weights=weight, x_scale=xs, x_zero_point=xz, weight_scale=per_channel_scale, y_scale=ys, y_zero_point=yz, prefix=prefix)
        replacements[i] = replacement
        constants.extend(tensors)
        generated_outputs.extend(name for n in replacement for name in n.output)
        removed.update((i, q_indices[0]))
        for j in dq_indices:
            if consumers[nodes[j].output[0]] == [i] and nodes[j].output[0] not in public_outputs:
                removed.add(j)
        layers.append(dict(name=node.name, input_shape=shape, weights_lossless=True, weight_axis=axis, weight_scale=per_channel_scale.tolist(), weight_zero_point=0, x_scale=float(xs), x_zero_point=int(xz), y_scale=float(ys), y_zero_point=int(yz), integer_conv_count=4))
    require(len(layers) == expected_count, "Wrong ConvTranspose count")
    kept = [n for i, node in enumerate(nodes) for n in (replacements[i] if i in replacements else ([] if i in removed else [node]))]
    model.graph.ClearField("node")
    model.graph.node.extend(kept)
    used = {name for n in kept for name in n.input} | public_outputs
    tensors = [t for t in model.graph.initializer if t.name in used]
    model.graph.ClearField("initializer")
    model.graph.initializer.extend([*tensors, *constants])
    live = used | {name for n in kept for name in n.output} | {v.name for v in model.graph.input}
    infos = [v for v in model.graph.value_info if v.name in live]
    model.graph.ClearField("value_info")
    model.graph.value_info.extend(infos)
    onnx.checker.check_model(model, full_check=True)
    model = onnx.shape_inference.infer_shapes(model, strict_mode=True)
    require(public_io(model) == public_io(original), "Public IO protobuf changed")
    require(all(values(model)[name].elem_type == TensorProto.UINT8 for name in generated_outputs), "Non-UINT8 polyphase layout")
    counts = Counter(n.op_type for n in model.graph.node)
    require(counts["ConvTranspose"] == 0 and counts["QLinearConv"] == 4*expected_count, "Incomplete integer lowering")
    return model, layers


def json_default(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(type(value).__name__)


def build(model_path, manifest_path, output, work_dir=None):
    model_path, manifest_path, output = map(Path, (model_path, manifest_path, output))
    inputs = {model_path.resolve(), manifest_path.resolve()}
    require(not inputs.intersection((output.resolve(), output.with_suffix(".json").resolve())), "Output and sidecar must not overwrite inputs")
    require(output.suffix == ".onnx", "Output must have .onnx suffix")
    original = onnx.load(model_path)
    onnx.checker.check_model(original, full_check=True)
    require(all(v.type.tensor_type.elem_type == TensorProto.FLOAT for v in [*original.graph.input, *original.graph.output]), "Expected float32 public IO")
    counts = Counter(n.op_type for n in original.graph.node)
    require(counts["Conv"] == 37 and counts["ConvTranspose"] == 3 and counts["InstanceNormalization"] == 32 and not any(n.op_type in ("QuantizeLinear", "DequantizeLinear", "QLinearConv") for n in original.graph.node), "Expected original FP32 37-Conv / three-CT / 32-normalization model")
    data = validate_manifest(model_path, manifest_path, original)
    reader = Reader(original.graph.input[0].name, [manifest_path.parent / item["path"] for item in data["calibration"]])
    if work_dir is not None:
        Path(work_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cpu-ptq-", dir=work_dir) as directory:
        qdq, config = quantize_qdq(model_path, reader, directory)
        require(public_io(qdq) == public_io(original), "PTQ changed public IO protobuf")
        final, layers = lower_conv_transposes(qdq, original)
        output.parent.mkdir(parents=True, exist_ok=True)
        onnx.save(final, output)
        stats = {"source": dict(bytes=model_path.stat().st_size, ops=dict(counts)), "qdq": dict(bytes=(Path(directory)/"qdq.onnx").stat().st_size, ops=dict(Counter(n.op_type for n in qdq.graph.node))), "output": dict(bytes=output.stat().st_size, ops=dict(Counter(n.op_type for n in final.graph.node)))}
    require(stats["output"]["ops"].get("Conv") == 37 and stats["output"]["ops"].get("InstanceNormalization") == 32, "Non-CT layers changed")
    report = dict(source=str(model_path), source_sha256=sha256(model_path), calibration_manifest=str(manifest_path), calibration_manifest_sha256=sha256(manifest_path), data=data, calibration_count=16, heldout_count=4, used_calibration_samples=sum(reader.used.values()), config=config, layers=layers, versions=dict(python=platform.python_version(), numpy=np.__version__, onnx=onnx.__version__, onnxruntime=ort.__version__), tools={str(Path(p).resolve()): sha256(p) for p in (__file__, polyphase.__file__)}, output=str(output), output_sha256=sha256(output), stats=stats, public_io="Unchanged float32 protobuf", runtime_changes=False, quality_validation="Requires separate browser WASM validation; no quantized CPU quality claim")
    output.with_suffix(".json").write_text(json.dumps(report, indent=2, sort_keys=True, default=json_default) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("model", "calibration-manifest", "output"):
        parser.add_argument("--" + flag, required=True, type=Path)
    parser.add_argument("--work-dir", type=Path, help="Parent for fresh temporary files (no cache)")
    args = parser.parse_args()
    report = build(args.model, args.calibration_manifest, args.output, args.work_dir)
    print(json.dumps({key: report[key] for key in ("output", "output_sha256", "used_calibration_samples", "stats")}, indent=2))
