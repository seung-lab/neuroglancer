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
   Optionally check **Agglomerate watershed basins** and set **Agglomeration
   threshold (agg_threshold)**. Agglomeration is **off by default**; its threshold
   draft starts at `0.15` and is used only when checked. Lower thresholds merge
   more basins.
5. Click **Add watershed layer**. A standard segmentation layer is added to the
   source's existing layer group, without changing the affinity layer or layout.
   One shared result covers the **XYZ bounding box enclosing all visible relevant
   slice views**, and follows navigation, resizing, and layout changes. There are
   no region/ROI fields or manual Run step.
6. To adjust an existing output, select its **Source** tab in the right sidebar.
   **Watershed parameters** provides live threshold sliders, mask/agglomeration
   checkboxes, precise numeric inputs, channel mapping, and **Halo (voxels)**.
   The dialog's controls remain drafts for newly added layers.

Creation publishes metadata, not a precomputed segmentation of the whole source.
The box is expressed in the selected scale's **native grid coordinates**. For the
first visible box, or when the visible box leaves the completed result's bounds,
one watershed computation runs after a **150 ms debounce**, over the entire box
plus the configured halo per face (**8 native voxels by default**), clipped to
source bounds. Navigation entirely inside the completed result reuses its labels,
without requiring a fresh halo around the new view. With the default halo, a single
axis-aligned XY view at native voxel Z = k allows scrolling from k − 8 through
k + 8 without recomputation, unless clipped by source bounds. All visible views
must remain inside the shared XYZ result.
Labels from this single shared result are fetched and rendered in ordinary
chunks; display-chunk requests never run watershed. Normal segmentation
visibility, selection, opacity, and colors apply; initially all nonzero labels
are shown with selected opacity `0.5`.

The computation box is limited to `2**21` (2,097,152) voxels, **including the clipped
halo**. An oversized view reports a visible error, not a partial segmentation:
**zoom in**, reduce the sidebar halo, or select a coarser native scale and add a
new layer. The box is never
silently split into separate computations. The existing layer and viewport
watcher stay active so navigation to a smaller box can retry. Computation waits
for **ALL affinity data needed for the current box**, including its clipped halo,
not just whichever display chunks arrive first. It does **not** wait for or read
the whole dataset.

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
- Optional **post-watershed agglomeration** merges neighboring nonzero basins
  when their **mean affinity across the shared boundary is strictly greater
  than** `aggThreshold`. Merged boundaries retain affinity sums and contact areas,
  so subsequent means are weighted by total contact area, not an unweighted
  average of boundary means. Final labels follow the full merge/remap chains.
  Background label `0` never merges. Existing size/dust cleanup runs **before**
  agglomeration and is not repeated afterward.
- `aggThreshold` must be finite and in `[0, 1]`. Absence disables agglomeration;
  **`0` enables it**, merging boundaries with positive mean affinity. A value of
  **`1` merges nothing**, since no normalized mean is strictly greater than `1`.
  Agglomeration does not recompact final label IDs: positive IDs may have gaps
  and are not guaranteed to be consecutive. Equal-score merges have no
  cross-platform canonical order; enabled results are not guaranteed to have
  identical IDs or partitions across native and WASM builds for tied inputs.
- All visible relevant slice rectangles contribute to **one enclosing XYZ box**,
  even if they lie in different views. A single computation includes the clipped
  halo as context; affinities leaving that computation domain are ignored.
- Output is **UINT64**: zero is background; positive labels are the local labels
  from the one completed shared result. Labels are consistent across display
  chunks within that result. Pending, hidden, unavailable, or failed regions
  return zero labels, not stale results.

The halo provides context but this bounded computation is **not equivalent to
whole-volume watershed**. Labels remain unchanged while navigating inside a
retained result, but may change when leaving it triggers a new computation; they
are not persistent object identities. Changing the source,
scale, channel mapping, or thresholds (including mask and agglomeration settings)
creates a different segmentation; IDs should not be compared across configurations.
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

A viewport box contained in the completed result preserves its labels and cached
output chunks. Moving outside that result immediately clears obsolete labels and
invalidates cached output chunks, then schedules one new full-domain computation
after the debounce. Completion also invalidates output caches so previously empty
chunks can reload.
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
and threshold controls **in the dialog**, including masking and agglomeration,
are drafts for the next layer. The **Source sidebar** edits the selected existing
layer instead, without replacing its retained affinity input or upstream ONNX
inference. Delete an output to stop its queued work and
release its resources. Deleting or replacing its affinity source, changing source
data or transforms, or resetting/disposal of the viewer also stops the dependent
live layer. For outputs created in the dialog, source invalidation is reported
there and removes the stopped output so cached labels cannot remain looking
valid. Restored layers own an independent hidden input, without depending on a
visible source layer's name or lifetime. If that hidden input fails, its data is
retired but the saved layer and recipe remain visible with an error until deleted.
Computation errors (including an oversized region) are also reported visibly and
clear the result, but **keep the layer and watcher alive** so a later viewport box
can retry. Fatal construction, publication, or activation errors still clean up
the failed output.

## Live sidebar parameters

Select a watershed output's **Source** tab to edit its current configuration:

- High and low thresholds have sliders and precise numeric inputs. Size and dust
  cleanup thresholds use unsigned-integer inputs.
- Masking and agglomeration have enable checkboxes, threshold sliders, and numeric
  inputs. Disabled thresholds retain their local draft but are omitted from saved
  options; an enabled threshold of `0` remains enabled.
- The three affinity channel indices can be changed, including repeated indices.
  Invalid channels or mask/channel combinations show an error without applying.
- **Halo (voxels)** is isotropic padding on all six faces in the selected scale's
  native voxel grid. It accepts nonnegative safe integers, including `0`; the
  slider covers `0–64`, while the numeric input allows larger values without
  silently clamping them. `0` computes only the visible union box.

A valid parameter edit clears obsolete labels and reuses the same prepared input,
output layer, and datasource. Rapid edits settle through the existing **150 ms
compute debounce**; an already-running synchronous kernel finishes before the
latest settings run, and obsolete results are discarded. Hidden outputs remain
idle until visible. Changing parameters forces a fresh computation even if the
view still fits inside the previous result's halo. Oversized boxes still report
an error rather than splitting; lowering the halo or shrinking the view recovers.

The sidebar updates the saved recipe and read-only JSON in place, without
reloading the source. Controls are disabled while loading. Affinity source,
native scale, and spacing are shown as read-only context: changing input geometry
requires adding a new layer and is not an upstream inference-setting edit.

## Saving, sharing, and restoration

New output layers use `watershed://recipe` with a JSON `source.state` recipe.
Saving or sharing viewer JSON preserves the affinity source specification
(including a nested ONNX recipe), native input scale and voxel spacing, literal
XYZ channel mapping, thresholds, optional last-channel mask threshold, and optional
agglomeration threshold, and the optional top-level `halo` in native voxels.
Omitting `halo` preserves the default `8`; explicit `0` is retained. Sidebar edits
are saved automatically and restored with the layer. Masking is enabled exactly
when `options.maskThreshold`
is present. Agglomeration is enabled exactly when `options.aggThreshold` is
present, including a value of `0`; omitting it preserves the default watershed-only
behavior. Unchecking **Agglomerate watershed basins** omits that key, regardless
of its retained threshold draft. The Source sidebar shows the complete, read-only
recipe JSON even while loading or after an error. Draft changes in the watershed
dialog apply only to newly added layers.

For example, the `options` object inside a layer's `source.state` can enable
agglomeration with:

```json
{
  "highThreshold": 0.99999,
  "lowThreshold": 0.00005,
  "sizeThreshold": 50,
  "dustThreshold": 50,
  "aggThreshold": 0.15
}
```

The JSON key is `aggThreshold`; `agg_threshold` in the dialog label identifies the
Abiss algorithm parameter. Remove the key to disable agglomeration, rather than
setting it to `0`. The existing default options do not include this key.

Restoring copied JSON reconstructs an independently owned live layer and
**recomputes one current-view union** using the saved settings. It does not
restore the old navigation box or its labels, compute the whole volume, or start
independent computations per display chunk. Restored computation likewise waits
for all affinity data needed for its current box, including the halo. Labels may
change with navigation just as for a newly created layer.

Shared state contains **no computed labels, affinity data, or local file bytes**.
The recipient still needs access and credentials for all upstream source URLs.
For ONNX-derived affinities, the nested inference recipe must use accessible
source and **model URLs**; the referenced model bytes must remain available and
match the saved model identity/hash. A model chosen from a local file is not
embedded in viewer JSON and cannot be restored by sharing that JSON alone. Old
session-only watershed or ONNX publication URLs remain **legacy, nonportable**
references; they cannot recreate their publications in another session. Recreate
those layers from portable source/model URLs before sharing.

## WASM provenance and licensing

The Abiss module is **GPL-3.0-or-later**, separately from the Apache-licensed
Neuroglancer adapters. The dialog links to its
[GPL license](../src/watershed/abiss/LICENSE) and
[complete corresponding source/build archive](../src/watershed/abiss/abiss-watershed-source.tar.gz);
both are included in production assets. See
[`src/watershed/abiss/README.md`](../src/watershed/abiss/README.md) for the pinned
Abiss commit, Emscripten version, checksums, ABI, and reproducible build details.
Post-watershed agglomeration is part of this GPL module. When redistributing a
modified WASM build, update the corresponding source/build archive to match the
shipped binary, including the agglomeration changes.

Tests compare browser WASM labels exactly with native Abiss reference outputs,
and exercise affinity reading, worker execution, live datasource publication, and
the viewer command. Numerical/geometry correctness does not establish
segmentation quality for a particular model or dataset.
