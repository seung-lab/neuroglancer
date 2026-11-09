#!/usr/bin/env python3
"""Lower the target depthwise ConvTranspose to standard CPU/WASM W8A8 ops.

Only NCDHW, depthwise multiplier one, kernel [1,4,4], strides [1,2,2],
pads [0,1,1,0,1,1], dilation one and no output padding are supported.
The caller supplies already-quantized weights and activation parameters; this
module performs no calibration, inference, file access, or runtime modification.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import onnx
from onnx import helper, numpy_helper


def phase_weights(weights: np.ndarray, p: int, q: int) -> np.ndarray:
    """K[p,q,r,s] = W[3-p-2*r, 3-q-2*s], without changing S8 codes."""
    if (not isinstance(weights, np.ndarray) or weights.dtype != np.int8
        or weights.ndim != 5 or weights.shape[0] <= 0
        or weights.shape[1:] != (1, 1, 4, 4)):
        raise ValueError("Expected INT8 weights [C,1,1,4,4]")
    if (not isinstance(p, (int, np.integer)) or not isinstance(q, (int, np.integer))
        or p not in (0, 1) or q not in (0, 1)):
        raise ValueError("Phase must be 0 or 1")
    return np.ascontiguousarray(
        np.take(np.take(weights, [3-p, 1-p], axis=3), [3-q, 1-q], axis=4)
    )


def lossless_power_of_two_weights(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return S8 weights and per-channel FP32 scales, rejecting lossy encoding.

    The step is 2**ceil(log2(maxabs/127)), not maxabs/127. Target bilinear
    coefficients therefore retain their exact FP32 values with scale 1/128
    and positive codes [8,24,72]. An all-zero channel uses scale one.
    """
    weights = np.asarray(weights)
    if (weights.dtype != np.float32 or weights.ndim != 5
        or weights.shape[0] <= 0 or weights.shape[1:] != (1, 1, 4, 4)):
        raise ValueError("Expected finite float32 weights [C,1,1,4,4]")
    if not np.isfinite(weights).all():
        raise ValueError("Nonfinite weights")
    maximum = np.max(np.abs(weights.astype(np.float64)), axis=(1, 2, 3, 4))
    scale = np.ones(maximum.shape, dtype=np.float32)
    nonzero = maximum > 0
    with np.errstate(over="ignore", under="ignore"):
        scale[nonzero] = np.exp2(np.ceil(np.log2(maximum[nonzero] / 127))).astype(np.float32)
    if not np.isfinite(scale).all() or np.any(scale <= 0):
        raise ValueError("Weight scale is not representable in float32")
    codes = np.rint(weights.astype(np.float64) / scale.reshape(-1, 1, 1, 1, 1))
    if np.any(codes < -127) or np.any(codes > 127):
        raise ValueError("Weight codes outside symmetric S8 range")
    quantized = codes.astype(np.int8)
    if not np.array_equal(quantized.astype(np.float32) * scale.reshape(-1, 1, 1, 1, 1), weights):
        raise ValueError("Weights do not admit lossless power-of-two S8 encoding")
    return quantized, scale


def _validate(
    input_shape: Sequence[int], weights: np.ndarray, x_scale: np.ndarray,
    x_zero_point: np.ndarray, weight_scale: np.ndarray, y_scale: np.ndarray,
    y_zero_point: np.ndarray, bias: np.ndarray | None,
) -> tuple[int, ...]:
    shape = tuple(input_shape)
    if len(shape) != 5 or any(
        not isinstance(s, (int, np.integer)) or isinstance(s, (bool, np.bool_)) or s <= 0
        for s in shape
    ):
        raise ValueError("Expected a positive static NCDHW input_shape")
    channels = shape[1]
    if (not isinstance(weights, np.ndarray) or weights.dtype != np.int8
        or weights.shape != (channels, 1, 1, 4, 4)):
        raise ValueError("Expected INT8 weights [C,1,1,4,4]")
    for name, value, dtype in (
        ("x_scale", x_scale, np.float32), ("y_scale", y_scale, np.float32),
        ("x_zero_point", x_zero_point, np.uint8), ("y_zero_point", y_zero_point, np.uint8),
    ):
        if not isinstance(value, np.ndarray) or value.dtype != dtype or value.shape != ():
            raise ValueError(f"{name} must be a scalar {np.dtype(dtype).name} ndarray")
    if (not isinstance(weight_scale, np.ndarray) or weight_scale.dtype != np.float32
        or weight_scale.shape not in ((), (channels,))):
        raise ValueError("weight_scale must be scalar or [C] float32")
    for scale in (x_scale, weight_scale, y_scale):
        if not np.isfinite(scale).all() or np.any(scale <= 0):
            raise ValueError("Scales must be finite and positive")
    with np.errstate(over="ignore", under="ignore", invalid="ignore", divide="ignore"):
        ratio = np.divide(np.multiply(x_scale, weight_scale, dtype=np.float32), y_scale, dtype=np.float32)
    if not np.isfinite(ratio).all() or np.any(ratio <= 0):
        raise ValueError("Requantization ratio must be finite and positive float32")
    if bias is not None and (not isinstance(bias, np.ndarray)
                             or bias.dtype != np.int32 or bias.shape != (channels,)):
        raise ValueError("Bias must be INT32 [C] in x_scale*weight_scale units")
    # Each output has at most four products. Bound all phases using int64,
    # including S8 -128 and asymmetric U8 centering; add the bias exactly once.
    b = np.zeros(channels, dtype=np.int64) if bias is None else bias.astype(np.int64)
    for p in (0, 1):
        for q in (0, 1):
            kernel = phase_weights(weights, p, q).astype(np.int64)
            low = -int(x_zero_point) * kernel
            high = (255-int(x_zero_point)) * kernel
            lower = np.minimum(low, high).sum(axis=(1, 2, 3, 4)) + b
            upper = np.maximum(low, high).sum(axis=(1, 2, 3, 4)) + b
            if np.any(lower < -(2**31)) or np.any(upper > 2**31-1):
                raise ValueError("Bias may overflow an int32 phase accumulator")
    return shape


def replacement_nodes(
    *, input_name: str, output_name: str, input_shape: Sequence[int],
    weights: np.ndarray, x_scale: np.ndarray, x_zero_point: np.ndarray,
    weight_scale: np.ndarray, y_scale: np.ndarray, y_zero_point: np.ndarray,
    bias: np.ndarray | None = None, prefix: str = "polyphase/",
) -> tuple[list[onnx.NodeProto], list[onnx.TensorProto]]:
    """Return four QLinearConv nodes, integer interleave, and their initializers.

    Input and output are UINT8. The caller owns the input QuantizeLinear and can
    reuse an existing output QuantizeLinear's name/parameters to keep downstream
    fusion unchanged. Parameter arrays must have the declared FP32/U8/S8 types;
    scales for X/Y are scalar and weight_scale is scalar or [C]. Bias, if any,
    is INT32 [C] in x_scale*weight_scale units, repeated unchanged in each phase.
    The prefix must be unique in the caller's graph. No input arrays are changed.
    """
    n, c, d, h, w = _validate(
        input_shape, weights, x_scale, x_zero_point, weight_scale, y_scale, y_zero_point, bias
    )
    if not prefix or input_name == output_name:
        raise ValueError("Use a nonempty unique prefix and distinct input/output names")
    nodes: list[onnx.NodeProto] = []
    tensors: dict[str, np.ndarray] = {}

    def constant(name, value):
        key = prefix + name
        tensors[key] = value
        return key

    xs = constant("x_scale", x_scale)
    xz = constant("x_zero_point", x_zero_point)
    ws = constant("w_scale", weight_scale)
    wz = constant("w_zero_point", np.zeros(weight_scale.shape, dtype=np.int8))
    ys = constant("y_scale", y_scale)
    yz = constant("y_zero_point", y_zero_point)
    bname = None if bias is None else constant("B", bias)
    phases = []
    for p in (0, 1):
        for q in (0, 1):
            output = prefix + f"phase{p}{q}"
            wn = constant(f"phase{p}{q}_W", phase_weights(weights, p, q))
            inputs = [input_name, xs, xz, wn, ws, wz, ys, yz]
            if bname is not None:
                inputs.append(bname)
            # Y[2u+p,2v+q] = sum X[u+p+r-1,v+q+s-1] K[p,q,r,s].
            nodes.append(helper.make_node(
                "QLinearConv", inputs, [output], name=output, group=c,
                kernel_shape=[1, 2, 2], strides=[1, 1, 1], dilations=[1, 1, 1],
                pads=[0, 1-p, 1-q, 0, p, q],
            ))
            phases.append(output)

    # Stack phases 00,01,10,11 after C, then split that axis into (p,q).
    # Only one Concat is needed; all layout data stays UINT8 throughout.
    phase_shape = constant("phase_shape", np.array([n, c, 1, d, h, w], dtype=np.int64))
    expanded = []
    for index, value in enumerate(phases):
        output = prefix + f"expanded{index}"
        nodes.append(helper.make_node("Reshape", [value, phase_shape], [output], name=output))
        expanded.append(output)
    stacked, joined, interleaved = prefix + "stacked", prefix + "joined", prefix + "interleaved"
    nodes.append(helper.make_node("Concat", expanded, [stacked], axis=2, name=stacked))
    joined_shape = constant("joined_shape", np.array([n, c, 2, 2, d, h, w], dtype=np.int64))
    nodes.append(helper.make_node("Reshape", [stacked, joined_shape], [joined], name=joined))
    nodes.append(helper.make_node(
        "Transpose", [joined], [interleaved], perm=[0, 1, 4, 5, 2, 6, 3], name=interleaved
    ))
    out_shape = constant("output_shape", np.array([n, c, d, 2*h, 2*w], dtype=np.int64))
    nodes.append(helper.make_node(
        "Reshape", [interleaved, out_shape], [output_name], name=prefix + "output"
    ))
    return nodes, [numpy_helper.from_array(value, name) for name, value in tensors.items()]
