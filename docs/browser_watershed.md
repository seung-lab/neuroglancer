# Browser WASM watershed

Add a live Abiss watershed segmentation over an existing affinity image without a
processing server. Ordinary volume datasources (including cloud-hosted
precomputed, Zarr, and N5 data) and existing browser ONNX inference layers use the
same native chunk reader. Network access and credentials for the source are still
required.

## Usage

1. Load a ready affinity **image** layer with a three-dimensional spatial domain
   and at least three channels. For ONNX output, first create the affinity layer
   with the existing ONNX inference command.
2. Open the command palette with **Ctrl+P** and select **WASM Watershed**.
3. Choose the affinity image and native scale.
4. Optionally expand **Advanced: channels and thresholds**. Map the channels for
   affinities to the voxel's **−X, −Y, and −Z** neighbors (default `0, 1, 2`) and
   adjust thresholds. Channel order is not inferred from a shader or model name.
5. Click **Add watershed layer**. A standard segmentation layer is added to the
   source's existing layer group, without changing the affinity layer or layout.
   Labels load for the **current view**, then on demand as you navigate.

There is no crop to enter or full-volume computation step. Creation publishes
metadata, not a precomputed segmentation of the whole source. Normal segmentation
visibility, selection, opacity, and colors apply; initially all nonzero labels are
shown with selected opacity `0.5`.

The selected scale's native voxel spacing and origin are preserved. Arbitrary
user transforms, reflected grids, and resampling are not supported; unsupported
mappings fail rather than silently changing the data. Native chunk indices and
backend origins must be exactly representable as float32 integers. Mutable
generation-based sources, including Python `LocalVolume`, are rejected: warm-cache revision
changes cannot be observed reliably through this input API. Static/cloud sources
and existing immutable ONNX publications are supported. Remote data is assumed
immutable for the lifetime of a source publication.

## Input and algorithm semantics

- Exactly three distinct channels are read and packed as planar `[3, Z, Y, X]`,
  X fastest. Other channels are ignored.
- `FLOAT32` affinities must be finite probabilities in `[0, 1]`. `UINT8` and
  `UINT16` are normalized by `255` and `65535` respectively. Rendered shader
  values, contrast settings, and display-channel selection do not affect input.
- High and low thresholds satisfy `0 ≤ low < high ≤ 1` in float32. Defaults are
  high `0.99999`, low `0.00005`, size `50`, and dust `50`. Size and dust are
  unsigned integer cleanup thresholds and can independently be zero.
- The automatic fixed grid has **64 × 64 × 32 voxel cores**, each computed with
  an **8-voxel halo per face**, clipped to the source bounds. The halo supplies
  context; only core labels are displayed. Affinities leaving the available
  computation domain are ignored.
- Output is **UINT64**: zero is background; positive labels encode stable
  **block-local IDs**, distinct across core blocks for a given configuration.
  Recomputing an evicted block does not renumber it. These are not global object
  identities: neighboring blocks are segmented independently, and an object
  crossing a boundary may have different IDs on either side.

Halos reduce edge effects but do not eliminate seams. There is **no global
stitching or whole-volume watershed**. Changing the source, scale, channel mapping,
or thresholds creates a different segmentation; IDs should not be compared
across configurations.

## Demand, caches, cancellation, and lifetime

The output is an ordinary demand-driven `VolumeChunkSource`: viewport requests
schedule bounded watershed work, and navigation requests additional blocks. It
uses Neuroglancer's standard chunk scheduling and CPU/GPU caches, rather than
retaining a full-volume label snapshot or a separate snapshot-memory budget.
Evicted blocks may be recomputed when revisited. Existing ONNX affinity images
are requested through their normal inference datasource, not a second ONNX path.

The watershed module runs in an asynchronous computation worker, without threads,
`SharedArrayBuffer`, or cross-origin-isolation requirements. Supported browsers
must support WebAssembly exceptions. Queued work and source chunk reads are
cancellable; a synchronous WASM call already started may finish in its worker,
but cancelled output is discarded. Work within a layer remains serialized until
the physical worker call finishes, so rapid navigation does not start overlapping
kernels for that layer.

Each output layer owns its publication, live computation, and retained affinity
input. **Closing the dialog does not stop created layers**, and selecting a
different source or scale in the dialog does not cancel existing outputs. Delete
an output to stop its queued work and release its resources. Deleting or replacing
its affinity source, changing source data or transforms, or resetting/disposal of
the viewer also stops the dependent live layer. Errors and source invalidation
are reported in the watershed dialog's status; the stopped output is removed so
cached labels cannot remain looking valid.

Result URLs use `watershed://…` and are **session-local**. Saving or sharing viewer
state does not serialize labels or a watershed recipe. A restored URL cannot
recreate the live layer: select the affinity source and add it again.

## WASM provenance and licensing

The Abiss module is **GPL-3.0-or-later**, separately from the Apache-licensed
Neuroglancer adapters. The dialog links to its
[GPL license](../src/watershed/abiss/LICENSE) and
[complete corresponding source/build archive](../src/watershed/abiss/abiss-watershed-source.tar.gz);
both are included in production assets. See
[`src/watershed/abiss/README.md`](../src/watershed/abiss/README.md) for the pinned
Abiss commit, Emscripten version, checksums, ABI, and reproducible build details.

Tests compare browser WASM labels exactly with native Abiss reference outputs,
and exercise affinity reading, worker execution, live datasource publication, and
the viewer command. Numerical/geometry correctness does not establish
segmentation quality for a particular model or dataset.
