#!/usr/bin/env python3
"""Small, backend-independent tests for the CPU/WASM four-phase lowering.

Run: python -m unittest discover -s build_tools -p test_inference_cpu_polyphase.py
Requires only numpy and onnx, not onnxruntime, external fixtures, or a GPU.
The reference enumerates the ORIGINAL 16-tap input scatter, not the lowering's
output/gather formula. Native/WASM backend validation is performed separately.
"""

from __future__ import annotations

import itertools
import unittest
from dataclasses import dataclass, replace

import numpy as np
import onnx
from inference_cpu_polyphase import (
    lossless_power_of_two_weights,
    phase_weights,
    replacement_nodes,
)
from onnx import TensorProto, helper, numpy_helper


@dataclass(frozen=True)
class Case:
    x: np.ndarray
    w: np.ndarray
    x_scale: np.ndarray
    x_zero_point: np.ndarray
    w_scale: np.ndarray
    y_scale: np.ndarray
    y_zero_point: np.ndarray
    bias: np.ndarray | None = None

    @property
    def yshape(self):
        n, c, d, h, w = self.x.shape
        return n, c, d, 2*h, 2*w


def scatter_oracle(case):
    """Independent int64 input scatter over all ORIGINAL 4x4 coefficients."""
    result = np.zeros(case.yshape, dtype=np.int64)
    for n, c, d, i, j in np.ndindex(case.x.shape):
        centered = int(case.x[n, c, d, i, j]) - int(case.x_zero_point)
        for a, b in itertools.product(range(4), repeat=2):
            row, col = 2*i-1+a, 2*j-1+b
            if 0 <= row < result.shape[3] and 0 <= col < result.shape[4]:
                result[n, c, d, row, col] += centered * int(case.w[c, 0, 0, a, b])
    if case.bias is not None:
        result += case.bias.astype(np.int64).reshape(1, -1, 1, 1, 1)
    return result


def requantize_oracle(accumulators, case):
    ratio = np.divide(np.multiply(case.x_scale, case.w_scale, dtype=np.float32), case.y_scale, dtype=np.float32)
    scaled = np.multiply(accumulators.astype(np.float32), ratio.reshape(1, -1, 1, 1, 1), dtype=np.float32)
    return np.clip(np.rint(scaled) + np.float32(case.y_zero_point), 0, 255).astype(np.uint8)


def make_model(case, **overrides):
    arguments = dict(
        input_name="existing_Xq", output_name="existing_Yq", input_shape=case.x.shape,
        weights=case.w, x_scale=case.x_scale, x_zero_point=case.x_zero_point,
        weight_scale=case.w_scale, y_scale=case.y_scale, y_zero_point=case.y_zero_point,
        bias=case.bias, prefix="layer0/polyphase/",
    )
    arguments.update(overrides)
    nodes, initializers = replacement_nodes(**arguments)
    model = helper.make_model(helper.make_graph(
        nodes, "polyphase_unit",
        [helper.make_tensor_value_info(arguments["input_name"], TensorProto.UINT8, case.x.shape)],
        [helper.make_tensor_value_info(arguments["output_name"], TensorProto.UINT8, case.yshape)],
        initializers,
    ), opset_imports=[helper.make_opsetid("", 20)], ir_version=9)
    onnx.checker.check_model(model, full_check=True)
    return model


def evaluate_graph(model, x):
    """Tiny NumPy interpreter of emitted ops; not an inference backend.

    Returns the final bytes AND each phase's unscaled accumulators. Comparing
    the latter to the scatter oracle prevents clipping/rounding from masking
    layout, kernel, padding, bias, batch, or channel errors.
    """
    values = {tensor.name: numpy_helper.to_array(tensor) for tensor in model.graph.initializer}
    values[model.graph.input[0].name] = x
    accumulators = []
    for node in model.graph.node:
        args = [values[name] for name in node.input]
        attrs = {attr.name: helper.get_attribute_value(attr) for attr in node.attribute}
        if node.op_type == "QLinearConv":
            source, xs, xz, weights, ws, wz, ys, yz, *bias = args
            n, c, d, h, w = source.shape
            assert attrs["group"] == c and weights.shape == (c, 1, 1, 2, 2)
            assert attrs["strides"] == attrs["dilations"] == [1, 1, 1]
            assert np.all(wz == 0)
            pads = attrs["pads"]
            assert pads[0] == pads[3] == 0
            hout, wout = h+pads[1]+pads[4]-1, w+pads[2]+pads[5]-1
            source = np.pad(source.astype(np.int64) - int(xz),
                            ((0, 0), (0, 0), (0, 0), (pads[1], pads[4]), (pads[2], pads[5])))
            accum = np.zeros((n, c, d, hout, wout), dtype=np.int64)
            for r, s in itertools.product(range(2), repeat=2):
                accum += source[:, :, :, r:r+hout, s:s+wout] * weights[:, 0, 0, r, s].astype(np.int64).reshape(1, c, 1, 1, 1)
            if bias:
                accum += bias[0].astype(np.int64).reshape(1, c, 1, 1, 1)
            accumulators.append(accum)
            ratio = np.divide(np.multiply(xs, ws, dtype=np.float32), ys, dtype=np.float32)
            scaled = np.multiply(accum.astype(np.float32), ratio.reshape(1, -1, 1, 1, 1), dtype=np.float32)
            result = np.clip(np.rint(scaled) + np.float32(yz), 0, 255).astype(np.uint8)
        elif node.op_type == "Reshape":
            result = args[0].reshape(tuple(args[1]))
        elif node.op_type == "Concat":
            result = np.concatenate(args, axis=attrs["axis"])
        elif node.op_type == "Transpose":
            result = args[0].transpose(attrs["perm"])
        else:
            raise AssertionError(f"Unexpected graph operation: {node.op_type}")
        assert result.dtype == np.uint8, (node.op_type, result.dtype)
        values[node.output[0]] = result
    return values[model.graph.output[0].name], accumulators


def small_cases():
    rng = np.random.default_rng(6280000)
    for c in (1, 2, 3, 5):
        for h, w in ((1, 1), (1, 3), (2, 2), (3, 1), (3, 3)):
            for scalar in (False, True):
                weights = rng.integers(-128, 128, (c, 1, 1, 4, 4), dtype=np.int16).astype(np.int8)
                weights[:, 0, 0, 0, 0] = -128
                yield Case(
                    rng.integers(0, 256, (2, c, 2, h, w), dtype=np.uint8), weights,
                    np.array(0.125, np.float32), np.array(113, np.uint8),
                    np.array(0.03125, np.float32) if scalar else np.arange(1, c+1, dtype=np.float32)/32,
                    np.array(0.5, np.float32), np.array(91, np.uint8),
                    np.arange(c, dtype=np.int32)*13-17,
                )


class TestInferenceCpuPolyphase(unittest.TestCase):
    def setUp(self):
        self.case = next(small_cases())

    def check_case(self, case):
        reference = scatter_oracle(case)
        model = make_model(case)
        restored = onnx.load_from_string(model.SerializeToString())
        actual, phases = evaluate_graph(restored, case.x)
        self.assertEqual(len(phases), 4)
        for index, phase in enumerate(phases):
            p, q = divmod(index, 2)
            np.testing.assert_array_equal(phase, reference[:, :, :, p::2, q::2])
        np.testing.assert_array_equal(actual, requantize_oracle(reference, case))
        return actual

    def test_batch_channels_odd_shapes_and_scalar_or_channel_scales(self):
        for case in small_cases():
            with self.subTest(shape=case.x.shape, scale_shape=case.w_scale.shape):
                self.check_case(case)

    def test_every_kernel_position_at_all_edges(self):
        base = replace(self.case, x=np.full((2, 1, 2, 3, 3), 113, np.uint8), bias=None)
        for row, col in ((0, 0), (0, 2), (2, 0), (2, 2), (1, 1)):
            for a, b in itertools.product(range(4), repeat=2):
                x = base.x.copy()
                x[0, 0, 0, row, col] = 114
                x[1, 0, 1, row, col] = 112
                weights = np.zeros_like(base.w)
                weights[0, 0, 0, a, b] = -128
                with self.subTest(row=row, col=col, a=a, b=b):
                    self.check_case(replace(base, x=x, w=weights))

    def test_ties_even_before_odd_zero_point(self):
        weights = np.zeros((1, 1, 1, 4, 4), np.int8)
        weights[0, 0, 0, 1:3, 1:3] = [[-7, -5], [5, 7]]
        case = Case(np.array([[[[[4]]]]], np.uint8), weights,
                    np.array(0.5, np.float32), np.array(3, np.uint8), np.array(1, np.float32),
                    np.array(1, np.float32), np.array(127, np.uint8))
        np.testing.assert_array_equal(self.check_case(case).reshape(-1), [123, 125, 129, 131])

    def test_both_saturation_endpoints(self):
        weights = np.zeros((2, 1, 1, 4, 4), np.int8)
        weights[0, 0, 0, 1:3, 1:3] = 127
        weights[1, 0, 0, 1:3, 1:3] = -128
        case = Case(np.full((2, 2, 1, 1, 1), 255, np.uint8), weights,
                    np.array(1, np.float32), np.array(7, np.uint8), np.array([1, 1], np.float32),
                    np.array(1, np.float32), np.array(123, np.uint8))
        actual = self.check_case(case)
        np.testing.assert_array_equal(actual[:, 0], 255)
        np.testing.assert_array_equal(actual[:, 1], 0)

    def test_padding_is_real_zero_and_bias_added_once(self):
        base = list(small_cases())[20]  # three channels
        case = replace(base, x=np.full_like(base.x, base.x_zero_point), bias=np.array([32, -32, 96], np.int32))
        np.testing.assert_array_equal(scatter_oracle(case), np.broadcast_to(case.bias.reshape(1, -1, 1, 1, 1), case.yshape))
        self.check_case(case)

    def test_nonbinary_scales_preserve_output_channel_mapping(self):
        case = replace(list(small_cases())[20], x_scale=np.array(0.073, np.float32),
                       w_scale=np.array([0.037, 0.081, 0.119], np.float32), y_scale=np.array(0.061, np.float32))
        self.check_case(case)

    def test_bias_overflow_both_directions_and_exact_endpoints(self):
        for limit in (-(2**31), 2**31-1):
            case = replace(self.case, bias=np.array([limit], np.int32))
            with self.assertRaisesRegex(ValueError, "overflow an int32"):
                make_model(case)
            make_model(replace(case, w=np.zeros_like(case.w)))
        for bias in (np.array([1], np.int64), np.array([[1]], np.int32), np.array([1, 2], np.int32)):
            with self.assertRaisesRegex(ValueError, "Bias must be INT32"):
                make_model(replace(self.case, bias=bias))

    def test_static_shape_and_weight_type_errors(self):
        for shape in ((1, 1, 3, 3), (1, 1, 1, 0, 1), (1, 1, 1, -1, 1), (1, 1, 1, "H", 1), (1, 1, 1, 1.0, 1), (1, 1, 1, True, 1)):
            with self.subTest(shape=shape), self.assertRaisesRegex(ValueError, "static NCDHW"):
                make_model(self.case, input_shape=shape)
        for weights in (np.zeros((1, 1, 2, 4, 4), np.int8), np.zeros((2, 1, 1, 4, 4), np.int8), self.case.w.astype(np.uint8)):
            with self.assertRaisesRegex(ValueError, "INT8 weights"):
                make_model(self.case, weights=weights)

    def test_scale_and_zero_point_errors(self):
        for mutation in (
            dict(x_scale=np.array(0, np.float32)), dict(y_scale=np.array(np.nan, np.float32)),
            dict(weight_scale=np.array(-1, np.float32)), dict(weight_scale=np.ones((1, 1), np.float32)),
            dict(weight_scale=np.array([1, 2], np.float32)), dict(weight_scale=np.array(1, np.float64)),
            dict(x_scale=np.array([1], np.float32)), dict(x_zero_point=np.array(113, np.int8)),
            dict(y_zero_point=np.array([91], np.uint8)),
            dict(x_scale=np.array(np.finfo(np.float32).max, np.float32), weight_scale=np.array(2, np.float32)),
            dict(x_scale=np.array(np.finfo(np.float32).smallest_subnormal, np.float32), weight_scale=np.array(0.125, np.float32)),
        ):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                make_model(self.case, **mutation)

    def test_graph_is_standard_four_depthwise_convs_and_byte_layout_only(self):
        model = make_model(self.case)
        operations = [node.op_type for node in model.graph.node]
        self.assertEqual(operations.count("QLinearConv"), 4)
        self.assertEqual(operations.count("Concat"), 1)
        self.assertEqual(operations.count("Transpose"), 1)
        self.assertTrue(set(operations) <= {"QLinearConv", "Concat", "Reshape", "Transpose"})
        self.assertEqual({node.domain for node in model.graph.node}, {""})
        self.assertEqual({op.domain for op in model.opset_import}, {""})
        self.assertEqual(model.graph.node[0].input[0], "existing_Xq")
        self.assertEqual(model.graph.node[-1].output[0], "existing_Yq")
        self.assertTrue(all(t.name.startswith("layer0/polyphase/") for t in model.graph.initializer))
        inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=True, data_prop=True)
        for info in [*inferred.graph.value_info, *inferred.graph.output]:
            self.assertEqual(info.type.tensor_type.elem_type, TensorProto.UINT8)
        for node, (p, q) in zip(model.graph.node[:4], itertools.product(range(2), repeat=2)):
            attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
            self.assertEqual(attrs["group"], self.case.x.shape[1])
            self.assertEqual(attrs["pads"], [0, 1-p, 1-q, 0, p, q])

    def test_input_arrays_not_modified_and_prefixes_are_independent(self):
        case = self.case
        arrays = [case.w, case.x_scale, case.x_zero_point, case.w_scale, case.y_scale, case.y_zero_point, case.bias]
        snapshots = [a.copy() for a in arrays]
        first = make_model(case, prefix="layer0/")
        second = make_model(case, prefix="layer1/")
        self.assertTrue({t.name for t in first.graph.initializer}.isdisjoint(t.name for t in second.graph.initializer))
        for actual, expected in zip(arrays, snapshots):
            np.testing.assert_array_equal(actual, expected)
        with self.assertRaisesRegex(ValueError, "unique prefix"):
            make_model(case, prefix="")
        with self.assertRaisesRegex(ValueError, "distinct input/output"):
            make_model(case, output_name="existing_Xq")

    def test_lossless_bilinear_weights_and_native_safe_products(self):
        vector = np.array([1, 3, 3, 1], np.float32)
        weights = np.tile((np.outer(vector, vector)/16).reshape(1, 1, 1, 4, 4), (3, 1, 1, 1, 1))
        quantized, scales = lossless_power_of_two_weights(weights)
        np.testing.assert_array_equal(scales, np.full(3, 1/128, np.float32))
        np.testing.assert_array_equal(np.unique(quantized), [8, 24, 72])
        np.testing.assert_array_equal(quantized.astype(np.float32)*scales.reshape(-1, 1, 1, 1, 1), weights)
        for p, q in itertools.product(range(2), repeat=2):
            np.testing.assert_array_equal(phase_weights(quantized, p, q).astype(np.int32).sum(axis=(1, 2, 3, 4)), 128)
        self.assertEqual(128*255, 32640)

    def test_lossless_encoding_zero_negative_and_nonrepresentable_weights(self):
        weights = np.zeros((2, 1, 1, 4, 4), np.float32)
        weights[1, 0, 0, :, :] = -0.5
        quantized, scales = lossless_power_of_two_weights(weights)
        np.testing.assert_array_equal(scales, [1, 1/128])
        np.testing.assert_array_equal(quantized[0], 0)
        np.testing.assert_array_equal(quantized[1], -64)
        for invalid in (np.full_like(weights, 0.1), np.full_like(weights, np.nan), weights.astype(np.float64), np.zeros((1, 1, 1, 3, 3), np.float32)):
            with self.assertRaises(ValueError):
                lossless_power_of_two_weights(invalid)

    def test_phase_selection_type_shape_and_invalid_parities(self):
        for p, q in ((-1, 0), (0, 2), (0.5, 0), (0, "1")):
            with self.assertRaisesRegex(ValueError, "Phase"):
                phase_weights(self.case.w, p, q)
        for weights in (self.case.w.astype(np.uint8), self.case.w[0], np.zeros((0, 1, 1, 4, 4), np.int8)):
            with self.assertRaisesRegex(ValueError, "INT8 weights"):
                phase_weights(weights, 0, 0)


if __name__ == "__main__":
    unittest.main()
