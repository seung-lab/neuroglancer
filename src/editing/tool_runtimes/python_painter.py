# Trimmed morphology kernel for the pyodide painting worker (TM-304).
#
# Mirrors `mask_compute.ts::applyMorphologyPipeline` using scipy.ndimage so the
# brush's binary-closing + connected-component filtering matches scipy
# bit-for-bit. Only the post-threshold morphology lives here; disk rasterization,
# thresholding, and chunk I/O stay in TypeScript on the main thread.
#
# Bundled as a string via `?raw` and `runPython`-ed once at worker boot; the
# worker then calls `apply_morphology` per request.

import json
import time

import numpy as np
from scipy.ndimage import label, binary_closing

# Per-call phase timings of the last `apply_morphology` run, as a JSON string.
# Read by the worker handler after each call and forwarded to the main-thread
# paint profiler, so the per-call cost splits into marshalling vs scipy compute.
last_timings_json = "{}"


def filter_components(mask, min_size):
    """Zero out 6-connected components with fewer than `min_size` voxels.

    Mirror of `mask_compute.ts::filterComponentsByMinSize`: `min_size <= 1` is a
    no-op (every voxel is its own component of size >= 1); otherwise components
    whose voxel count is strictly less than `min_size` are removed. scipy
    `label`'s default structuring element is the connectivity-1 cross
    (6-connected in 3D), matching the TS BFS.
    """
    if min_size <= 1:
        return mask
    labels, _ = label(mask)
    sizes = np.bincount(labels.ravel())
    valid = sizes >= min_size
    valid[0] = False  # background is never kept
    return valid[labels]


def apply_morphology(
    mask_bytes,
    sx,
    sy,
    sz,
    binary_closing_iterations,
    min_component_size,
    filter_components_first,
):
    """Apply binary closing + component-min-size filter to a prebuilt mask.

    Args:
        mask_bytes: JS Uint8Array of 0/1, row-major (x, y, z) with x fastest.
        sx, sy, sz: mask dimensions (x, y, z).
        binary_closing_iterations: closing iterations; 0 disables.
        min_component_size: minimum kept component size; <= 1 disables.
        filter_components_first: True -> filter then close; False -> close then
            filter. Matches `MorphologyPipelineInput.filterComponentsFirst`.

    Returns:
        A `bytes` object of 0/1 in the same (x, y, z) row-major layout.
    """
    global last_timings_json
    t0 = time.perf_counter()
    buf = mask_bytes.to_py()
    # Row-major (x, y, z) with x fastest <=> C-order (z, y, x) with x last/fastest.
    m = np.frombuffer(buf, dtype=np.uint8).reshape((sz, sy, sx)).astype(bool)

    # Drop singleton axes so scipy's default cross structuring element spans only
    # the real dimensions. This matches `mask_compute.ts`, whose `binaryClose3D`
    # / `filterComponentsByMinSize` skip extent-1 axes (so a [w, h, 1] disk slab
    # is processed as a 2D, 4-connected plane). Without the squeeze, scipy's 3D
    # element treats the out-of-plane neighbors as border 0 and erosion wipes the
    # whole 1-voxel-thick slab during closing. `atleast_1d` guards the 1x1x1 case
    # (r = 0). Squeezing length-1 axes preserves C-order byte layout, so the
    # result's `tobytes()` matches the original (z, y, x) ordering.
    m = np.atleast_1d(np.squeeze(m))
    t1 = time.perf_counter()

    closing_ms = 0.0
    components_ms = 0.0
    if filter_components_first:
        tc = time.perf_counter()
        m = filter_components(m, min_component_size)
        components_ms = (time.perf_counter() - tc) * 1000.0
        if binary_closing_iterations > 0:
            tc = time.perf_counter()
            m = binary_closing(m, iterations=binary_closing_iterations)
            closing_ms = (time.perf_counter() - tc) * 1000.0
    else:
        if binary_closing_iterations > 0:
            tc = time.perf_counter()
            m = binary_closing(m, iterations=binary_closing_iterations)
            closing_ms = (time.perf_counter() - tc) * 1000.0
        tc = time.perf_counter()
        m = filter_components(m, min_component_size)
        components_ms = (time.perf_counter() - tc) * 1000.0

    t2 = time.perf_counter()
    out = m.astype(np.uint8).tobytes()
    t3 = time.perf_counter()
    last_timings_json = json.dumps(
        {
            "marshalInMs": (t1 - t0) * 1000.0,
            "closingMs": closing_ms,
            "componentsMs": components_ms,
            "marshalOutMs": (t3 - t2) * 1000.0,
        }
    )
    return out
