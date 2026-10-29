#!/usr/bin/env python3
"""Prepare a separate padding-only nooverseg ONNX model for ORT Web/NCHW.

Tool-only dependencies: numpy and onnx (tested with onnx 1.23.2).
This is deliberately not a general ONNX optimizer or a browser-side rewrite.
ConvTranspose nodes and all initializers are preserved unchanged.
"""

import argparse
import copy
import os
import tempfile
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


class PreparationError(ValueError):
    """The source does not satisfy the explicitly supported rewrite profile."""


def require(condition, message):
    if not condition:
        raise PreparationError(message)


def tensor_shape(value):
    tensor = value.type.tensor_type
    require(tensor.elem_type == TensorProto.FLOAT, f"{value.name}: expected float32")
    dims = tensor.shape.dim
    require(
        bool(dims) and all(d.HasField("dim_value") and d.dim_value > 0 for d in dims),
        f"{value.name}: expected a static positive shape",
    )
    return [d.dim_value for d in dims]


def checked_inference(model):
    try:
        onnx.checker.check_model(model, full_check=True)
        return onnx.shape_inference.infer_shapes(model, strict_mode=True)
    except (onnx.checker.ValidationError, onnx.shape_inference.InferenceError) as error:
        raise PreparationError(f"invalid ONNX model: {error}") from error


def prepare_model(source: onnx.ModelProto) -> onnx.ModelProto:
    """Return a checked, independent model with only Conv padding rewritten."""
    model = copy.deepcopy(source)
    require(
        [(x.domain, x.version) for x in model.opset_import] == [("", 10)],
        "expected the nooverseg default-domain opset 10 profile",
    )
    require(not model.functions, "local functions are not supported")
    graph = model.graph
    require(not graph.sparse_initializer, "sparse initializers are not supported")
    for values, name, shape in (
        (graph.input, "input", [1, 1, 20, 80, 80]),
        (graph.output, "output", [1, 4, 20, 80, 80]),
    ):
        require(len(values) == 1 and values[0].name == name, f"expected only {name!r}")
        require(tensor_shape(values[0]) == shape, f"{name}: expected shape {shape}")
    allowed_ops = {
        "Conv",
        "ConvTranspose",
        "InstanceNormalization",
        "Relu",
        "Add",
        "MaxPool",
        "Sigmoid",
        "Concat",
    }
    for node in graph.node:
        require(
            not node.domain and node.op_type in allowed_ops,
            f"{node.name}: unsupported operator {node.domain}:{node.op_type}",
        )
        require(
            not any(a.type in (a.GRAPH, a.GRAPHS) for a in node.attribute),
            f"{node.name}: nested graphs are not supported",
        )
    # Infer on a separate copy for validation only; preserve source metadata.
    inferred = checked_inference(model).graph
    shapes = {
        v.name: tensor_shape(v)
        for v in [*inferred.input, *inferred.value_info, *inferred.output]
    }
    weights = {v.name: numpy_helper.to_array(v) for v in graph.initializer}
    require(
        not set(weights).intersection(v.name for v in graph.input),
        "overridable initializer inputs are not supported",
    )

    def weight(name, node):
        require(name in weights, f"{node.name}: weight/bias must be an initializer")
        value = weights[name]
        require(
            value.dtype == np.float32 and np.isfinite(value).all(),
            f"{node.name}: weight/bias must be finite float32",
        )
        return value

    conv_count = 0
    for index, node in enumerate(graph.node):
        if node.op_type != "Conv":
            continue
        label = node.name or f"node {index}"
        require(len(node.output) == 1, f"{label}: expected one output")
        require(
            len(node.input) in (2, 3), f"{label}: expected data, weights, optional bias"
        )
        x = shapes.get(node.input[0])
        y = shapes.get(node.output[0])
        require(x is not None and len(x) == 5, f"{label}: expected static NCDHW input")
        require(y is not None and len(y) == 5, f"{label}: expected static NCDHW output")
        w = weight(node.input[1], node)
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        require(w.ndim == 5, f"{label}: expected rank-five weights")
        kernel = list(w.shape[2:])
        pads = [(k - 1) // 2 for k in kernel]
        require(
            all(k > 0 and k % 2 == 1 for k in kernel),
            f"{label}: expected odd Conv kernels",
        )
        require(
            attrs
            == {
                "kernel_shape": kernel,
                "group": 1,
                "strides": [1, 1, 1],
                "dilations": [1, 1, 1],
                "pads": pads + pads,
            },
            f"{label}: Conv requires stride/dilation 1, group 1 and matching symmetric pads",
        )
        require(
            w.shape[1] == x[1] and y == [x[0], w.shape[0], *x[2:]],
            f"{label}: Conv weight/input/output shapes do not match",
        )
        if len(node.input) == 3:
            require(
                weight(node.input[2], node).shape == (w.shape[0],),
                f"{label}: invalid Conv bias shape",
            )
        attributes = [copy.deepcopy(a) for a in node.attribute if a.name != "pads"]
        del node.attribute[:]
        node.attribute.extend(attributes)
        node.attribute.append(helper.make_attribute("auto_pad", "SAME_UPPER"))
        conv_count += 1
    require(conv_count > 0, "expected Conv padding rewrites")
    checked_inference(model)
    return model


def prepare_file(source: Path, output: Path) -> None:
    """Publish a self-contained model exclusively, with no overwrite option."""
    source, output = Path(source), Path(output)
    require(
        source.resolve() != output.resolve(),
        "source and output must be different files",
    )
    require(
        not os.path.lexists(output),
        f"output already exists (will not overwrite): {output}",
    )
    model = prepare_model(onnx.load(source))
    # A same-directory temporary + exclusive link prevents partial output and
    # refuses even a destination created after the initial existence check.
    with tempfile.TemporaryDirectory(
        prefix=".nooverseg-jsep-", dir=output.parent
    ) as tmp:
        temporary = Path(tmp) / "prepared.onnx"
        onnx.save_model(model, temporary, save_as_external_data=False)
        onnx.checker.check_model(temporary, full_check=True)
        os.link(temporary, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="original nooverseg.onnx (not modified)"
    )
    parser.add_argument(
        "output", type=Path, help="new, non-existing prepared .onnx path"
    )
    args = parser.parse_args()
    try:
        prepare_file(args.source, args.output)
    except (PreparationError, OSError, onnx.checker.ValidationError) as error:
        parser.exit(1, f"preparation failed: {error}\n")
    print(f"Prepared padding-only NCHW model: {args.output} (source unchanged)")


if __name__ == "__main__":
    main()
