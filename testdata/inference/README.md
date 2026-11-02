# Deterministic ONNX fixture

`concat.onnx` is a 201-byte, weight-free ONNX ModelProto (IR 5, opset 10), producer
`neuroglancer-test`. Its graph is `Concat(input,input,input,input, axis=1)`, with
float32 input `[1,1,20,80,80]` and output `[1,4,20,80,80]`. Every output channel is
exactly the input. The live browser smokes therefore compare every displayed
voxel in all four channels to `Float32(raw uint8 / 255)` after cropping and
blending. Source samples are divided once by their dtype maximum before inference;
there is no user-selectable affine scale/offset. Direct float32 model inputs are
unchanged. Output uses
full 60×60×16 XYZ display chunks. No Python inference service is required, and
these checks do not claim correctness of nooverseg.

Equivalent generation using the optional Python `onnx` package:

```python
from onnx import TensorProto, helper, save

node = helper.make_node(
    "Concat", ["input"] * 4, ["output"], name="repeat-channels", axis=1
)
graph = helper.make_graph(
    [node], "deterministic-concat",
    [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 1, 20, 80, 80])],
    [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 4, 20, 80, 80])],
)
model = helper.make_model(
    graph, producer_name="neuroglancer-test", ir_version=5,
    opset_imports=[helper.make_opsetid("", 10)],
)
save(model, "concat.onnx")
```

This fixture is test data, not part of ordinary viewer assets. The real local
`nooverseg.onnx` is intentionally not tracked or bundled.
