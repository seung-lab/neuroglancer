"""Tiny CPU unit tests; no full-model calibration, benchmark, or new dependencies.

Run: python -m unittest discover -s build_tools -p test_quantize_inference_cpu.py
"""

import copy
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization.calibrate import CalibraterBase

if __package__:
    from . import quantize_inference_cpu as tool
else:
    import quantize_inference_cpu as tool


def tiny_model(channels=3, count=1):
    shape = [1, channels, 1, 2, 3]
    bilinear = np.outer([0.25, 0.75, 0.75, 0.25], [0.25, 0.75, 0.75, 0.25]).astype(np.float32)
    weights = np.stack([bilinear * (2.0 ** -c) for c in range(channels)])[:, None, None]
    nodes = [helper.make_node("ConvTranspose", ["X", "W"], [f"Y{i}"], name=f"ct{i}", group=channels, kernel_shape=[1, 4, 4], strides=[1, 2, 2], pads=[0, 1, 1, 0, 1, 1]) for i in range(count)]
    nodes.append(helper.make_node("Identity", ["X"], ["unchanged"], name="float_identity"))
    outputs = [helper.make_tensor_value_info(f"Y{i}", TensorProto.FLOAT, [1, channels, 1, 4, 6]) for i in range(count)]
    outputs.append(helper.make_tensor_value_info("unchanged", TensorProto.FLOAT, shape))
    model = helper.make_model(helper.make_graph(nodes, "tiny_ct", [helper.make_tensor_value_info("X", TensorProto.FLOAT, shape)], outputs, [numpy_helper.from_array(weights, "W")]), opset_imports=[helper.make_opsetid("", 20)], ir_version=9)
    onnx.checker.check_model(model, full_check=True)
    return model


def bounded_session(calibrator):
    # Bound only tiny test sessions; never modify ORT or production calibration.
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    calibrator.infer_session = ort.InferenceSession(calibrator.augmented_model_path, sess_options=options, providers=["CPUExecutionProvider"])


def scatter(x, weights):
    """Independent CT scatter definition, not phase/gather/interleave code."""
    n, channels, depth, height, width = x.shape
    result = np.zeros((n, channels, depth, 2*height, 2*width), np.float64)
    for batch, c, d, h, w in np.ndindex(x.shape):
        for r, s in np.ndindex(4, 4):
            y, z = 2*h+r-1, 2*w+s-1
            if 0 <= y < 2*height and 0 <= z < 2*width:
                result[batch, c, d, y, z] += float(x[batch, c, d, h, w]) * float(weights[c, 0, 0, r, s])
    return result


class TestQuantizeInferenceCpu(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        bounded = patch.object(CalibraterBase, "create_inference_session", bounded_session)
        bounded.start()
        self.addCleanup(bounded.stop)
        self.fixture_index = 0

    def quantized_fixture(self, channels=3, count=1):
        directory = self.root / str(self.fixture_index)
        directory.mkdir()
        self.fixture_index += 1
        original = tiny_model(channels, count)
        source = directory / "fp32.onnx"
        onnx.save(original, source)
        rng = np.random.default_rng(6280000)
        samples = [rng.uniform(-1, 1, [1, channels, 1, 2, 3]).astype(np.float32) for _ in range(3)]
        paths = []
        for i, sample in enumerate(samples):
            path = directory / f"sample{i}.npy"
            np.save(path, sample)
            paths.append(path)
        reader = tool.Reader("X", paths)
        qdq, config = tool.quantize_qdq(source, reader, directory)
        return original, qdq, config, reader, samples

    def test_actual_qdq_to_integer_matches_scatter(self):
        for channels, count in ((2, 1), (3, 3)):
            with self.subTest(channels=channels, count=count):
                original, qdq, config, reader, samples = self.quantized_fixture(channels, count)
                original_qdq = copy.deepcopy(qdq)
                lowered, layers = tool.lower_conv_transposes(qdq, original, expected_count=count)
                counts = Counter(n.op_type for n in lowered.graph.node)
                self.assertEqual(counts["QLinearConv"], 4*count)
                self.assertEqual(counts["ConvTranspose"], 0)
                self.assertEqual(tool.public_io(lowered), tool.public_io(original))
                self.assertEqual(reader.used, Counter({0: 1, 1: 1, 2: 1}))
                self.assertEqual(config["extra_options"]["CalibStridedMinMax"], 1)
                self.assertEqual(config["extra_options"]["CalibPercentile"], 99.99)
                overrides = config["extra_options"]["TensorQuantOverrides"]["W"]
                self.assertEqual(overrides[0]["axis"], 0)
                self.assertEqual(len(overrides), channels)
                weights = numpy_helper.to_array(original.graph.initializer[0])
                arrays = {t.name: numpy_helper.to_array(t) for t in original_qdq.graph.initializer}
                for ct in (n for n in original_qdq.graph.node if n.op_type == "ConvTranspose"):
                    wdq = next(n for n in original_qdq.graph.node if ct.input[1] in n.output)
                    qweight, scale, zero = [arrays[name] for name in wdq.input]
                    np.testing.assert_array_equal(qweight.astype(np.float32) * scale[:, None, None, None, None], weights)
                    self.assertFalse(np.any(zero))
                types = tool.values(onnx.shape_inference.infer_shapes(lowered, strict_mode=True))
                for node in lowered.graph.node:
                    if node.name.startswith("cpu_polyphase"):
                        self.assertTrue(all(types[name].elem_type == TensorProto.UINT8 for name in node.output))
                onnx.checker.check_model(lowered, full_check=True)
                options = ort.SessionOptions()
                options.intra_op_num_threads = options.inter_op_num_threads = 1
                session = ort.InferenceSession(lowered.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"])
                for sample in samples:
                    outputs = session.run(None, {"X": sample})
                    xs, xz = layers[0]["x_scale"], layers[0]["x_zero_point"]
                    identity_reference = (np.clip(np.rint(sample / np.float32(xs)) + np.float32(xz), 0, 255) - np.float32(xz)) * np.float32(xs)
                    np.testing.assert_array_equal(outputs[-1], identity_reference)
                    for output, layer in zip(outputs, layers):
                        xs, xz, ys, yz = [layer[k] for k in ("x_scale", "x_zero_point", "y_scale", "y_zero_point")]
                        xcodes = np.clip(np.rint(sample / np.float32(xs)) + xz, 0, 255)
                        decoded_x = (xcodes.astype(np.float64) - xz) * xs
                        reference = scatter(decoded_x, weights)
                        expected = (np.clip(np.rint(reference / ys) + yz, 0, 255) - yz) * ys
                        self.assertEqual(output.dtype, np.float32)
                        self.assertTrue(np.isfinite(output).all())
                        # Native requantization may differ at a tie by one code.
                        np.testing.assert_allclose(output, expected, rtol=0, atol=1.01*ys)
                        error_bound = float(np.max(np.abs(weights).sum(axis=(1, 2, 3, 4)))) * xs/2 + 1.51*ys
                        np.testing.assert_allclose(output, scatter(sample, weights), rtol=0, atol=error_bound)
                by_name = {n.name: n for n in lowered.graph.node}
                # Non-CT nodes survive PTQ-to-lowering verbatim.
                for node in original_qdq.graph.node:
                    if node.op_type not in ("ConvTranspose", "QuantizeLinear", "DequantizeLinear"):
                        self.assertEqual(by_name[node.name], node)

    def test_shared_dqs_and_other_nodes_are_not_removed(self):
        for weight_axis in (0, 1):
            with self.subTest(weight_axis=weight_axis):
                original, qdq, _, _, _ = self.quantized_fixture()
                ct = next(n for n in qdq.graph.node if n.op_type == "ConvTranspose")
                dqs = [next(n for n in qdq.graph.node if name in n.output) for name in ct.input]
                if weight_axis == 1:
                    # Accept a lossless axis-1 DQ (one scale shared across C).
                    weights = numpy_helper.to_array(original.graph.initializer[0])
                    replacements = [np.rint(weights / np.float32(1/128)).astype(np.int8), np.array([1/128], np.float32), np.array([0], np.int8)]
                    for name, array in zip(dqs[1].input, replacements):
                        tensor = next(t for t in qdq.graph.initializer if t.name == name)
                        tensor.CopyFrom(numpy_helper.from_array(array, name))
                    next(a for a in dqs[1].attribute if a.name == "axis").i = 1
                for i, dq in enumerate(dqs):
                    qdq.graph.node.append(helper.make_node("Identity", [dq.output[0]], [f"shared{i}"], name=f"keep{i}"))
                lowered, _ = tool.lower_conv_transposes(qdq, original, expected_count=1)
                for dq in dqs:
                    self.assertIn(dq, lowered.graph.node)
                for node in qdq.graph.node:
                    if node.op_type == "Identity":
                        self.assertIn(node, lowered.graph.node)
                for node in lowered.graph.node:
                    if node.op_type == "QLinearConv":
                        self.assertEqual(node.input[0], dqs[0].input[0])

    def test_lowering_rejects_invalid_patterns(self):
        for failure in ("geometry", "missing_quantizer", "lossy_weight", "public_io", "wrong_count"):
            with self.subTest(failure=failure):
                original, qdq, _, _, _ = self.quantized_fixture()
                ct = next(n for n in qdq.graph.node if n.op_type == "ConvTranspose")
                expected = 1
                if failure == "geometry":
                    ct.attribute.append(helper.make_attribute("output_padding", [0, 1, 0]))
                elif failure == "missing_quantizer":
                    quantizer = next(n for n in qdq.graph.node if n.op_type == "QuantizeLinear" and n.input[0] == ct.output[0])
                    quantizer.op_type = "Identity"
                    del quantizer.input[1:]
                    for node in qdq.graph.node:
                        if node.op_type == "DequantizeLinear" and node.input[0] == quantizer.output[0]:
                            node.op_type = "Identity"
                            del node.input[1:]
                elif failure == "lossy_weight":
                    wdq = next(n for n in qdq.graph.node if ct.input[1] in n.output)
                    tensor = next(t for t in qdq.graph.initializer if t.name == wdq.input[0])
                    codes = numpy_helper.to_array(tensor).copy()
                    codes[0, 0, 0, 0, 0] += 1
                    tensor.CopyFrom(numpy_helper.from_array(codes, tensor.name))
                elif failure == "public_io":
                    qdq.graph.output[0].doc_string = "changed"
                else:
                    expected = 3
                with self.assertRaises((ValueError, onnx.shape_inference.InferenceError)):
                    tool.lower_conv_transposes(qdq, original, expected_count=expected)

    def manifest_fixture(self):
        model = tiny_model(channels=1)
        source = self.root / "source.onnx"
        onnx.save(model, source)
        records = []
        for i in range(20):
            raw_path, path = self.root / f"raw{i}.npy", self.root / f"input{i}.npy"
            raw = np.arange(6, dtype=np.uint8).reshape(3, 2, 1, 1) + np.uint8(i)
            np.save(raw_path, raw)
            np.save(path, raw[..., 0].transpose(2, 1, 0)[None, None].astype(np.float32) / np.float32(255))
            records.append(dict(path=path.name, raw_path=raw_path.name, sha256=tool.sha256(path), raw_sha256=tool.sha256(raw_path), lower_xyz=[4*i, 0, 0], upper_xyz_exclusive=[4*i+3, 2, 1]))
        data = dict(model_sha256=tool.sha256(source), normalization=tool.NORMALIZATION, input_layout="NCDHW (ZYX spatial)", shape_xyz=[3, 2, 1], resolution_xyz_nm=[16, 16, 45], scale="16_16_45", calibration=records[:16], validation=records[16:])
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps(data))
        return model, source, manifest, data

    def test_output_and_sidecar_cannot_overwrite_inputs(self):
        _, source, manifest, _ = self.manifest_fixture()
        before = {path: path.read_bytes() for path in (source, manifest)}
        for output in (source, manifest.with_suffix(".onnx")):
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, "overwrite inputs"):
                tool.build(source, manifest, output)
            for path, content in before.items():
                self.assertEqual(path.read_bytes(), content)
        self.assertFalse(manifest.with_suffix(".onnx").exists())

    def test_manifest_and_reader_validate_and_consume_every_sample(self):
        model, source, manifest, _ = self.manifest_fixture()
        data = tool.validate_manifest(source, manifest, model)
        reader = tool.Reader("X", [self.root / r["path"] for r in data["calibration"]])
        for i in reversed(range(len(reader))):
            reader.set_range(i, i+1)
            np.testing.assert_array_equal(reader.get_next()["X"], np.load(self.root / data["calibration"][i]["path"]))
            self.assertIsNone(reader.get_next())
        self.assertEqual(reader.used, Counter({i: 1 for i in range(16)}))
        with self.assertRaisesRegex(ValueError, "reader range"):
            reader.set_range(0, 17)

    def test_manifest_rejects_invalid_provenance_or_data(self):
        for failure in ("model_hash", "missing_hash", "missing_data", "heldout_hash", "normalization", "data_normalization", "overlap", "count", "raw_shape"):
            with self.subTest(failure=failure):
                model, source, manifest, data = self.manifest_fixture()
                if failure == "model_hash":
                    data["model_sha256"] = "0"*64
                elif failure == "missing_hash":
                    del data["calibration"][0]["raw_sha256"]
                elif failure == "missing_data":
                    (self.root / data["calibration"][0]["path"]).unlink()
                elif failure == "heldout_hash":
                    data["validation"][0]["sha256"] = "0"*64
                elif failure == "normalization":
                    data["normalization"] = "uint8 / 256"
                elif failure == "data_normalization":
                    record = data["calibration"][0]
                    path = self.root / record["path"]
                    np.save(path, np.load(path) + np.float32(0.1))
                    record["sha256"] = tool.sha256(path)
                elif failure == "overlap":
                    data["validation"][0].update(lower_xyz=[0, 0, 0], upper_xyz_exclusive=[3, 2, 1])
                elif failure == "raw_shape":
                    record = data["calibration"][0]
                    path = self.root / record["raw_path"]
                    np.save(path, np.load(path)[..., 0])
                    record["raw_sha256"] = tool.sha256(path)
                else:
                    data["calibration"].pop()
                manifest.write_text(json.dumps(data))
                with self.assertRaises((ValueError, FileNotFoundError)):
                    tool.validate_manifest(source, manifest, model)


if __name__ == "__main__":
    unittest.main()
