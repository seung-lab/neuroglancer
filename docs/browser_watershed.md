# Browser WASM watershed

Add a live Abiss watershed segmentation over an existing affinity image without a
processing server. Ordinary volume datasources (including cloud-hosted
precomputed, Zarr, and N5 data) and existing browser ONNX inference layers use the
same native chunk reader. Network access and credentials for the source are still
required.

## Usage

1. Load a ready affinity **image** layer with a three-dimensional spatial domain.
   Native scalar XYZ images and XYZC images with one or more channels are
   supported. For ONNX output, first create the affinity layer with the existing
   ONNX inference command.
2. Open the command palette with **Ctrl+P** and select **WASM Watershed**.
3. Choose the affinity image and native scale.
4. Optionally expand **Advanced: channels and thresholds**. Map the channels for
   affinities to the voxel's **−X, −Y, and −Z** neighbors. A scalar XYZ or XYZC1
   source defaults to `0, 0, 0`: the same values are copied literally for all three
   axes. Sources with at least three channels default to `0, 1, 2`; two-channel
   sources also default to `0, 0, 0`. Repeated indices are allowed, and channel
   order is not inferred from a shader or model name. With at least four source
   channels, optionally check **Use last channel as mask** and adjust **Mask
   threshold** (default `0.3`). Masking is **off by default**; the mask is always
   the last source channel, which cannot also be selected as an affinity.
5. Click **Add watershed layer**. A standard segmentation layer is added to the
   source's existing layer group, without changing the affinity layer or layout.
   One shared result covers the **XYZ bounding box enclosing all visible relevant
   slice views**, and follows navigation, resizing, and layout changes. There are
   no region/ROI fields or manual Run step.

Creation publishes metadata, not a precomputed segmentation of the whole source.
The box is expressed in the selected scale's **native grid coordinates**. After a
**150 ms debounce**, one watershed computation runs over the entire box plus an
**8-voxel halo per face**, clipped to source bounds. Labels from this single shared
result are fetched and rendered in ordinary chunks; display-chunk requests never
run watershed. Normal segmentation visibility, selection, opacity, and colors
apply; initially all nonzero labels are shown with selected opacity `0.5`.

The computation box is limited to `2**21` (2,097,152) voxels, **including the clipped
halo**. An oversized view reports a visible error, not a partial segmentation:
**zoom in**, or select a coarser native scale and add a new layer. The box is never
silently split into separate computations. The existing layer and viewport
watcher stay active so navigation to a smaller box can retry.

The selected scale's native voxel spacing and origin are preserved. Arbitrary
user transforms, reflected grids, and resampling are not supported; unsupported
mappings fail rather than silently changing the data. Native chunk indices and
backend origins must be exactly representable as float32 integers. Mutable
generation-based sources, including Python `LocalVolume`, are rejected: warm-cache revision
changes cannot be observed reliably through this input API. Static/cloud sources
and existing immutable ONNX publications are supported. Remote data is assumed
immutable for the lifetime of a source publication.

## Input and algorithm semantics

- Three affinity planes are read according to the selected channel indices and
  packed as planar `[3, Z, Y, X]`, X fastest. Indices must be in bounds but may
  repeat, including `0, 0, 0`. A repeated scalar plane is copied unchanged; this
  is **not** the neighbor-minimum conversion used by Abiss's Python scalar helper.
  There is no neighbor-minimum mode.
- `FLOAT32` inputs must be finite probabilities in `[0, 1]`. `UINT8` and `UINT16`
  are normalized by `255` and `65535` respectively for **every plane read**,
  including the optional mask. Rendered shader values, contrast settings, and
  display-channel selection do not affect input.
- Optional masking requires at least four source channels and reads the **last
  channel** as a background/myelin mask, packed as a fourth plane. The three
  selected affinity indices must exclude this channel, but may still repeat.
  With masking off, no mask plane is read and other channels are ignored; the
  last channel may be selected as an ordinary affinity.
- **Mask threshold** must be finite and in `[0, 1]`, in normalized units even for
  integer sources, not the raw integer mask units used by Abiss's Python helper.
  Its default is `0.3`. Keep a voxel only if its normalized mask value is
  **strictly less than** the threshold; equality and larger values are suppressed.
  Before watershed, zero each affinity edge if **either endpoint** is masked.
  This changes the affinity graph, not a post-watershed label mask: labels are
  **not post-masked**.
- High and low thresholds satisfy `0 ≤ low < high ≤ 1` in float32. Defaults are
  high `0.99999`, low `0.00005`, size `50`, and dust `50`. Size and dust are
  unsigned integer cleanup thresholds and can independently be zero.
- All visible relevant slice rectangles contribute to **one enclosing XYZ box**,
  even if they lie in different views. A single computation includes the clipped
  halo as context; affinities leaving that computation domain are ignored.
- Output is **UINT64**: zero is background; positive labels are the local labels
  from the one completed shared result. Labels are consistent across display
  chunks within that result. Pending, hidden, unavailable, or failed regions
  return zero labels, not stale results.

The halo provides context but this bounded computation is **not equivalent to
whole-volume watershed**. Labels may change across navigation as the enclosing
box changes; they are not persistent object identities. Changing the source,
scale, channel mapping, or thresholds (including mask settings) creates a
different segmentation; IDs should not be compared across configurations.
Automatic channel defaults follow source/scale changes; valid user-entered
mappings are preserved, while mappings that become invalid when the channel count
changes are reset. Masking is turned off when the selected source/scale has fewer
than four channels.

## Demand, caches, cancellation, and lifetime

The output is an ordinary `VolumeChunkSource`, using Neuroglancer's standard chunk
scheduling and CPU/GPU caches to fetch and render labels copied from **one retained
completed region result**. Display-chunk requests never trigger watershed or
independent label numbering. Existing ONNX affinity images are requested through
their normal inference datasource, not a second ONNX path.

A changed viewport box immediately clears obsolete labels and invalidates cached
output chunks, then schedules one new full-domain computation after the debounce.
Completion also invalidates output caches so previously empty chunks can reload.
Hiding the output, or having no visible relevant slice view, clears the region and
cancels pending work. Showing it again resumes viewport tracking. The source may
be much larger than the computation cap; it is not read in full at creation.

The watershed module runs in an asynchronous computation worker, without threads,
`SharedArrayBuffer`, or cross-origin-isolation requirements. Supported browsers
must support WebAssembly exceptions. Queued work and source chunk reads are
cancellable; a synchronous WASM call already started may finish in its worker,
but cancelled output is discarded. Work within a layer remains serialized until
the physical worker call finishes, so rapid navigation does not start overlapping
kernels for that layer.

Each output layer owns its publication, live computation, and retained affinity
input. **Closing the dialog does not stop created layers**, and selecting a
different source or scale in the dialog does not cancel existing outputs. Channel
and mask controls are drafts for the next layer; editing them does not change an
existing layer's configuration. Delete an output to stop its queued work and
release its resources. Deleting or replacing its affinity source, changing source
data or transforms, or resetting/disposal of the viewer also stops the dependent
live layer. Source invalidation is reported in the watershed dialog's status and
removes the stopped output so cached labels cannot remain looking valid.
Computation errors (including an oversized region) are also reported visibly and
clear the result, but **keep the layer and watcher alive** so a later viewport box
can retry. Fatal construction, publication, or activation errors still clean up
the failed output.

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
