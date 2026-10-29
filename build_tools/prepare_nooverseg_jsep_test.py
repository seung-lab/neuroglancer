"""Offline tool tests: python -m unittest build_tools.prepare_nooverseg_jsep_test.

Requires tool-only numpy/onnx; numeric tests additionally require onnxruntime.
No browser, user model, environment installation, or application build is needed.
"""

import copy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from build_tools.prepare_nooverseg_jsep import (
    PreparationError,
    prepare_file,
    prepare_model,
)

try:
    import onnxruntime as ort
except ImportError:
    ort = None


def fixture():
    """Small graph with the real fixed I/O profile and channel/depth ordering."""
    rng = np.random.default_rng(42)
    conv = rng.standard_normal((4, 1, 1, 3, 3)).astype(np.float32)
    kernel = rng.standard_normal((1, 1, 1, 4, 4)).astype(np.float32)
    weights = [
        numpy_helper.from_array(conv, "conv_weight"),
        numpy_helper.from_array(np.repeat(kernel, 4, axis=0), "up_weight"),
        numpy_helper.from_array(np.arange(4, dtype=np.float32) / 4, "bias"),
        numpy_helper.from_array(np.ones(1, dtype=np.float32), "unused"),
    ]
    nodes = [
        helper.make_node(
            "MaxPool", ["input"], ["pooled"], kernel_shape=[1, 2, 2], strides=[1, 2, 2]
        ),
        helper.make_node(
            "Conv",
            ["pooled", "conv_weight", "bias"],
            ["convolved"],
            name="conv",
            kernel_shape=[1, 3, 3],
            strides=[1, 1, 1],
            dilations=[1, 1, 1],
            group=1,
            pads=[0, 1, 1, 0, 1, 1],
        ),
        helper.make_node(
            "ConvTranspose",
            ["convolved", "up_weight"],
            ["output"],
            name="up",
            kernel_shape=[1, 4, 4],
            strides=[1, 2, 2],
            dilations=[1, 1, 1],
            pads=[0, 1, 1, 0, 1, 1],
            group=4,
        ),
    ]
    return helper.make_model(
        helper.make_graph(
            nodes,
            "preparation-test",
            [
                helper.make_tensor_value_info(
                    "input", TensorProto.FLOAT, [1, 1, 20, 80, 80]
                )
            ],
            [
                helper.make_tensor_value_info(
                    "output", TensorProto.FLOAT, [1, 4, 20, 80, 80]
                )
            ],
            weights,
        ),
        opset_imports=[helper.make_opsetid("", 10)],
        ir_version=5,
    )


def set_attribute(node, name, value):
    kept = [copy.deepcopy(a) for a in node.attribute if a.name != name]
    del node.attribute[:]
    node.attribute.extend([*kept, helper.make_attribute(name, value)])


class PreparationTest(unittest.TestCase):
    def assert_conv_only_preparation(self, source, result):
        expected = copy.deepcopy(source)
        for node in expected.graph.node:
            if node.op_type == "Conv":
                kept = [copy.deepcopy(a) for a in node.attribute if a.name != "pads"]
                del node.attribute[:]
                node.attribute.extend(
                    [*kept, helper.make_attribute("auto_pad", "SAME_UPPER")]
                )
        self.assertEqual(len(result.graph.node), len(source.graph.node))
        self.assertEqual(
            [n.SerializeToString() for n in result.graph.node if n.op_type != "Conv"],
            [n.SerializeToString() for n in source.graph.node if n.op_type != "Conv"],
        )
        self.assertEqual(
            [v.SerializeToString() for v in result.graph.initializer],
            [v.SerializeToString() for v in source.graph.initializer],
        )
        # Includes metadata, I/O, value_info and all remaining protobuf fields.
        self.assertEqual(result, expected)

    def test_rewrite_and_source_invariance(self):
        model = fixture()
        original = model.SerializeToString()
        result = prepare_model(model)
        self.assertEqual(original, model.SerializeToString())
        self.assert_conv_only_preparation(model, result)
        self.assertEqual(
            [n.op_type for n in result.graph.node],
            ["MaxPool", "Conv", "ConvTranspose"],
        )
        conv_attrs = {
            a.name: helper.get_attribute_value(a)
            for a in result.graph.node[1].attribute
        }
        self.assertEqual(conv_attrs["auto_pad"], b"SAME_UPPER")
        self.assertNotIn("pads", conv_attrs)
        self.assertEqual(
            [v.name for v in result.graph.initializer],
            ["conv_weight", "up_weight", "bias", "unused"],
        )
        onnx.checker.check_model(result, full_check=True)
        onnx.shape_inference.infer_shapes(result, strict_mode=True)

    @unittest.skipIf(ort is None, "numeric test requires tool-only onnxruntime")
    def test_numeric_cpu_match(self):
        model = fixture()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        sessions = [
            ort.InferenceSession(
                m.SerializeToString(), options, providers=["CPUExecutionProvider"]
            )
            for m in (model, prepare_model(model))
        ]
        rng = np.random.default_rng(2026)
        for value in (
            rng.standard_normal((1, 1, 20, 80, 80)).astype(np.float32),
            np.linspace(-1, 1, 20 * 80 * 80, dtype=np.float32).reshape(
                1, 1, 20, 80, 80
            ),
        ):
            with self.subTest(input_sum=float(value.sum())):
                expected, actual = (s.run(None, {"input": value})[0] for s in sessions)
                self.assertTrue(np.isfinite(actual).all())
                np.testing.assert_array_equal(actual, expected)

    def test_reject_profile(self):
        for tensor, dimension, size in (("input", 2, 21), ("output", 1, 3)):
            with self.subTest(tensor=tensor):
                model = fixture()
                value = getattr(model.graph, tensor)[0]
                value.type.tensor_type.shape.dim[dimension].dim_value = size
                with self.assertRaisesRegex(PreparationError, "expected shape"):
                    prepare_model(model)
        model = fixture()
        model.graph.input[0].type.tensor_type.elem_type = TensorProto.DOUBLE
        with self.assertRaisesRegex(PreparationError, "expected float32"):
            prepare_model(model)
        model = fixture()
        model.graph.input[0].type.tensor_type.shape.dim[2].dim_param = "depth"
        with self.assertRaisesRegex(PreparationError, "static positive"):
            prepare_model(model)

    def test_reject_opset(self):
        model = fixture()
        model.opset_import[0].version = 11
        with self.assertRaisesRegex(PreparationError, "opset 10"):
            prepare_model(model)

    def test_reject_asymmetric_conv_padding(self):
        model = fixture()
        # Same total padding/output shape, but not SAME_UPPER semantics.
        set_attribute(model.graph.node[1], "pads", [0, 0, 2, 0, 2, 0])
        with self.assertRaisesRegex(PreparationError, "matching symmetric pads"):
            prepare_model(model)

    def test_reject_conv_stride_dilation_kernel_or_group(self):
        for key, value in (
            ("strides", [1, 2, 2]),
            ("dilations", [1, 2, 2]),
            ("kernel_shape", [1, 2, 2]),
            ("group", 2),
        ):
            with self.subTest(attribute=key):
                model = fixture()
                set_attribute(model.graph.node[1], key, value)
                with self.assertRaises(PreparationError):
                    prepare_model(model)

    def test_preserve_transpose_attributes(self):
        # These valid variants are unrelated to the Conv padding rewrite.
        for key, value in (
            ("output_padding", [0, 0, 0]),
            ("auto_pad", "NOTSET"),
            ("output_shape", [20, 80, 80]),
        ):
            with self.subTest(attribute=key):
                model = fixture()
                set_attribute(model.graph.node[2], key, value)
                self.assert_conv_only_preparation(model, prepare_model(model))

    def test_preserve_different_group_weights(self):
        model = fixture()
        w = numpy_helper.to_array(model.graph.initializer[1]).copy()
        w[2, 0, 0, 1, 3] += 0.125
        model.graph.initializer[1].CopyFrom(numpy_helper.from_array(w, "up_weight"))
        self.assert_conv_only_preparation(model, prepare_model(model))

    def test_preserve_transpose_bias(self):
        model = fixture()
        model.graph.node[2].input.append("bias")
        self.assert_conv_only_preparation(model, prepare_model(model))

    def test_preserve_nonfinite_transpose_weights(self):
        model = fixture()
        w = numpy_helper.to_array(model.graph.initializer[1]).copy()
        w[:] = np.nan
        model.graph.initializer[1].CopyFrom(numpy_helper.from_array(w, "up_weight"))
        self.assert_conv_only_preparation(model, prepare_model(model))

    def test_reject_nonfinite_conv_weights(self):
        model = fixture()
        w = numpy_helper.to_array(model.graph.initializer[0]).copy()
        w[:] = np.nan
        model.graph.initializer[0].CopyFrom(numpy_helper.from_array(w, "conv_weight"))
        with self.assertRaisesRegex(PreparationError, "finite float32"):
            prepare_model(model)

    def test_files_never_clobbered(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "source.onnx", Path(tmp) / "prepared.onnx"
            onnx.save(fixture(), source)
            original = source.read_bytes()
            prepare_file(source, output)
            self.assertEqual(source.read_bytes(), original)
            expected = output.read_bytes()
            with self.assertRaisesRegex(PreparationError, "already exists"):
                prepare_file(source, output)
            self.assertEqual(output.read_bytes(), expected)
            with self.assertRaisesRegex(PreparationError, "different files"):
                prepare_file(source, source)
            alias = Path(tmp) / "alias.onnx"
            alias.symlink_to(source)
            with self.assertRaisesRegex(PreparationError, "different files"):
                prepare_file(source, alias)
            onnx.checker.check_model(output, full_check=True)

    def test_failed_validation_leaves_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "source.onnx", Path(tmp) / "prepared.onnx"
            model = fixture()
            set_attribute(model.graph.node[1], "pads", [0, 0, 2, 0, 2, 0])
            onnx.save(model, source)
            with self.assertRaises(PreparationError):
                prepare_file(source, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [source])

    def test_exclusive_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "source.onnx", Path(tmp) / "prepared.onnx"
            onnx.save(fixture(), source)

            def competing_writer(temporary, destination):
                destination.write_bytes(b"concurrent output")
                raise FileExistsError("destination created during preparation")

            with mock.patch(
                "build_tools.prepare_nooverseg_jsep.os.link",
                side_effect=competing_writer,
            ):
                with self.assertRaises(FileExistsError):
                    prepare_file(source, output)
            self.assertEqual(output.read_bytes(), b"concurrent output")
            self.assertEqual(set(Path(tmp).iterdir()), {source, output})


if __name__ == "__main__":
    unittest.main()
