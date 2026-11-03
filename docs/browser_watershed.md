# Browser WASM watershed

Run Abiss watershed on an existing affinity image layer without a processing
server. Both ordinary volume datasources (including cloud-hosted precomputed,
Zarr, and N5 data) and browser ONNX inference layers use the same native chunk
reader. Network access and credentials for the source are still required.

## Usage

1. Load an affinity **image** layer with a three-dimensional spatial domain and
   at least three channels. For ONNX output, first create the affinity layer with
   the existing ONNX inference command.
2. Open the command palette with **Ctrl+P** and select **WASM Watershed**.
3. Choose the layer and native scale. Enter the ROI's native XYZ lower corner and
   XYZ size; the dialog shows the available bounds.
4. Map the channels for affinities to the voxel's **−X, −Y, and −Z** neighbors.
   Defaults are channels `0, 1, 2`. Channel order is not inferred from a shader or
   model name.
5. Set the thresholds and click **Run watershed**. A normal segmentation layer
   is added to the source's layer group when the whole region is complete.

The ROI coordinates are in the selected scale's native grid, not viewport pixels
or physical coordinates. Arbitrary user transforms, reflected grids, and
resampling are not supported; unsupported mappings fail rather than silently
changing the data. Native voxel spacing and origin are preserved in the result.

## Input and algorithm semantics

- Exactly three distinct channels are read and packed as planar `[3, Z, Y, X]`,
  X fastest. Other channels are ignored.
- `FLOAT32` affinities must be finite probabilities in `[0, 1]`. `UINT8` and
  `UINT16` are normalized by `255` and `65535` respectively. Rendered shader
  values, contrast settings, and display-channel selection do not affect input.
- High and low thresholds satisfy `0 ≤ low < high ≤ 1` in float32. Defaults are
  high `0.99999`, low `0.00005`, size `50`, and dust `50`. Size and dust are
  unsigned integer cleanup thresholds and can independently be zero.
- Output is `UINT32`: zero is background; positive labels are local to this run.
  Affinities leaving the ROI are ignored.

Each run processes **one connected ROI**, at most **2,097,152 voxels**. The default
size is up to `128 × 128 × 64`, clipped to the source bounds. The ROI is not
independently segmented per display chunk: there is **no cross-run stitching or
global label identity**. Separate runs may assign unrelated IDs and disagree at
boundaries. This is an interactive bounded-region tool, not whole-volume
segmentation.

## Execution, cancellation, and lifetime

The reader requests source chunks sequentially and supports demand-driven ONNX
output through the existing inference datasource. It does not run ONNX a second
way. The watershed module runs in an asynchronous computation worker, without
threads, `SharedArrayBuffer`, or cross-origin-isolation requirements. Supported
browsers must support WebAssembly exceptions.

Cancel, viewer reset, or source replacement prevents pending results from being
published. Source generations are checked between chunk reads and before
publication; a generation change during a run invalidates that run.
A synchronous WASM call that has already started may finish in its
worker; its cancelled result is discarded. Closing the dialog does not cancel a
run. A completed segmentation is a private snapshot and no longer depends on the
source layer. Deleting it releases its publication; snapshots are limited to
128 MiB per viewer chunk manager, separate from normal render caches.

Result URLs use `watershed://…` and are **session-local**. Saving or sharing viewer
state does not serialize the labels or a watershed recipe. Reloading such a URL
reports that watershed must be rerun.

## WASM provenance and licensing

The Abiss module is **GPL-3.0-or-later**, separately from the Apache-licensed
Neuroglancer adapters. The dialog links to its license and complete corresponding
source/build archive; both are included in production assets. See
[`src/watershed/abiss/README.md`](../src/watershed/abiss/README.md) for the pinned
Abiss commit, Emscripten version, checksums, ABI, and reproducible build details.

Tests compare browser WASM labels exactly with native Abiss reference outputs,
and exercise affinity reading, worker execution, datasource publication, and the
viewer command. Numerical/geometry correctness does not establish segmentation
quality for a particular model or dataset.
