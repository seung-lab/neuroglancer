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

# Same, for the last `apply_paint_pipeline` run (TM-317 whole-pipeline path).
last_pipeline_timings_json = "{}"

# JS data-type string -> numpy dtype. uint64 is excluded upstream (uint64 image
# layers cannot be thresholded against a number band), so it is intentionally
# absent here; an unknown type falls back to uint8.
_NUMPY_DTYPES = {
    "uint8": np.uint8,
    "int8": np.int8,
    "uint16": np.uint16,
    "int16": np.int16,
    "uint32": np.uint32,
    "int32": np.int32,
    "float32": np.float32,
}


def _numpy_dtype(data_type_str):
    return _NUMPY_DTYPES.get(data_type_str, np.uint8)


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


# Row-stripe height for the footprint distance pass. Bounds the float64
# temporaries to `STRIPE * width * 8` bytes per op regardless of brush size, so a
# huge stamp (r≈512, footprint up to ~12M voxels) never allocates the hundreds of
# MB that tripped the worker's 500 MB heap watermark → cold reinit.
_FOOTPRINT_STRIPE_ROWS = 256


def _footprint_mask(tx, ty, lo_tx, lo_ty, points, radius, r2):
    """Rasterize the union of per-segment capsules of `points` (footprint only).

    Returns the (t_sy, t_sx) bool swept-capsule footprint — no thresholding.
    Bit-for-bit twin of `painting_compute.ts::segmentDistanceSq` /
    `rasterizePolylineFootprint`. `tx`/`ty` are 1-D float64 ABSOLUTE target voxel
    coordinate arrays (`tx[i] = lo_tx + i`); `points` is an (N, 2) array of
    un-floored target voxel coords (one point = disk, two = capsule, more = the
    union of consecutive segments).

    Two narrowings keep cost proportional to the brush, not its bounding box:

      * Per SEGMENT, only its own capsule sub-bbox.
      * Per row-STRIPE, an x-CLIP to a SUPERSET of the stadium's x-extent over
        those rows (expand the band by `radius`, map to the segment x-span, pad
        by `radius`), so a long diagonal capsule skips its empty bbox corners.
        Because the window is a superset, the exact `dist² <= r²` test over it is
        byte-identical to testing the full sub-bbox.

    Striping also caps peak temporaries to `stripe × window × 4` bytes, so a huge
    stamp never allocates the 100s of MB that tripped the worker's heap watermark.

    The per-voxel distance test runs in FLOAT32 over LOCAL footprint coordinates
    (`0..w-1`, `0..h-1`). Distance is translation-invariant, so shifting to a
    local origin is exact in reals and keeps float32 precise — absolute target
    coords (~1e5) would catastrophically cancel in float32 (resolution ~0.016
    voxel). This is ~2x cheaper than float64 but NOT bit-identical to the float64
    main-thread `segmentDistanceSq`: capsule-EDGE voxels can differ sub-voxel
    (~0.3% of the footprint). The main-thread fallback (cold-init / worker
    failure) stays float64, so a stroke can differ by those edge voxels depending
    on which path ran — an accepted trade-off (TM-317 P3) for the off-thread
    speedup. The window/clip math below stays float64; it only needs to be a
    superset of the inside set, which it remains (it pads the segment by an
    integer `radius`, far more than the sub-voxel float32 boundary shift).
    """
    w = tx.shape[0]
    h = ty.shape[0]
    inside = np.zeros((h, w), dtype=bool)
    # Local float32 coordinate axes (`txl[i] = i`). Integer-valued and < 2^24, so
    # exactly representable in float32; the float32 rounding enters only through
    # the fractional segment endpoints (`axl32` etc.) below.
    txl = np.arange(w, dtype=np.float32)
    tyl = np.arange(h, dtype=np.float32)
    r2_32 = np.float32(r2)
    n = points.shape[0]
    n_segments = max(1, n - 1)
    for k in range(n_segments):
        ax = points[k, 0]
        ay = points[k, 1]
        if n > 1:
            bx = points[k + 1, 0]
            by = points[k + 1, 1]
        else:
            bx = ax
            by = ay
        # Segment capsule sub-bbox in LOCAL footprint indices (clip to bounds).
        ix0 = int(np.floor(min(ax, bx))) - radius - lo_tx
        ix1 = int(np.ceil(max(ax, bx))) + radius - lo_tx
        iy0 = int(np.floor(min(ay, by))) - radius - lo_ty
        iy1 = int(np.ceil(max(ay, by))) + radius - lo_ty
        if ix0 < 0:
            ix0 = 0
        if iy0 < 0:
            iy0 = 0
        if ix1 > w - 1:
            ix1 = w - 1
        if iy1 > h - 1:
            iy1 = h - 1
        if ix1 < ix0 or iy1 < iy0:
            continue
        abx = bx - ax
        aby = by - ay
        len2 = abx * abx + aby * aby
        # float32 LOCAL-coordinate segment params for the per-voxel distance
        # (window/clip math above stays float64). The endpoints carry the brush's
        # fractional position; everything else (txl/tyl) is integer-exact.
        axl32 = np.float32(ax - lo_tx)
        ayl32 = np.float32(ay - lo_ty)
        abx32 = np.float32(abx)
        aby32 = np.float32(aby)
        len2_32 = abx32 * abx32 + aby32 * aby32
        for ys in range(iy0, iy1 + 1, _FOOTPRINT_STRIPE_ROWS):
            ye = min(ys + _FOOTPRINT_STRIPE_ROWS, iy1 + 1)
            # Per-stripe x-window: superset of the stadium's x-extent over these
            # rows. Expanding the band by `radius` captures the perpendicular
            # foot of any inside voxel, so its x lies within
            # `segment-x(t over the band) ± radius`.
            ya = lo_ty + ys - radius
            yb = lo_ty + (ye - 1) + radius
            if by != ay:
                ta = (ya - ay) / (by - ay)
                tb = (yb - ay) / (by - ay)
                t1 = ta if ta < tb else tb
                t2 = tb if ta < tb else ta
                t1 = 0.0 if t1 < 0.0 else (1.0 if t1 > 1.0 else t1)
                t2 = 0.0 if t2 < 0.0 else (1.0 if t2 > 1.0 else t2)
            else:
                t1 = 0.0
                t2 = 1.0
            segx1 = ax + t1 * abx
            segx2 = ax + t2 * abx
            sxlo = (segx1 if segx1 < segx2 else segx2) - radius
            sxhi = (segx2 if segx1 < segx2 else segx1) + radius
            wx0 = int(np.floor(sxlo)) - lo_tx
            wx1 = int(np.ceil(sxhi)) - lo_tx
            if wx0 < ix0:
                wx0 = ix0
            if wx1 > ix1:
                wx1 = ix1
            if wx1 < wx0:
                continue
            sub_x = txl[wx0 : wx1 + 1][np.newaxis, :]  # (1, sw) float32 local
            sub_y = tyl[ys:ye][:, np.newaxis]  # (sh, 1) float32 local
            if len2 > 0.0:
                # Perpendicular-foot distance, same structure as the main-thread
                # `segmentDistanceSq`, in float32 over local coords and in place
                # to bound the (sh, sw) temporaries:
                #   t  = ((sub_x-axl)*abx + (sub_y-ayl)*aby) / len2, clipped [0,1]
                #   dx = sub_x - (axl + t*abx);  dy = sub_y - (ayl + t*aby)
                #   inside |= dx*dx + dy*dy <= r2
                xterm = (sub_x - axl32) * abx32  # (1, sw) f32
                yterm = (sub_y - ayl32) * aby32  # (sh, 1) f32
                t = xterm + yterm  # (sh, sw) f32 via broadcast
                t /= len2_32
                np.clip(t, 0.0, 1.0, out=t)
                dx = t * abx32
                dx += axl32  # axl + t*abx
                np.subtract(sub_x, dx, out=dx)  # sub_x - (axl + t*abx)
                dx *= dx  # dx²
                dy = t * aby32
                dy += ayl32  # ayl + t*aby
                np.subtract(sub_y, dy, out=dy)  # sub_y - (ayl + t*aby)
                dy *= dy  # dy²
                dx += dy  # dx² + dy²
                inside[ys:ye, wx0 : wx1 + 1] |= dx <= r2_32
            else:
                dx = sub_x - axl32
                dy = sub_y - ayl32
                inside[ys:ye, wx0 : wx1 + 1] |= (dx * dx + dy * dy) <= r2_32
    return inside


def _threshold_footprint_coverage_inplace(
    inside, image, ix_lo, ix_hi, iy_lo, iy_hi, thr_low, thr_high, coverage
):
    """In place, zero footprint voxels whose covered image block fails coverage.

    `inside` is the (t_sy, t_sx) bool footprint. For each target voxel `(i, j)`,
    its covered image block is `[ix_lo[i]..ix_hi[i]] x [iy_lo[j]..iy_hi[j]]`
    (slab-local indices, TM-339). The voxel is kept iff at least
    `min_pass = clip(ceil(coverage * total), 1, total)` of the block's image
    voxels are within `[thr_low, thr_high]` — the SAME integer arithmetic as the
    TS twin (`paint_pipeline_ts.ts`) and main-thread fallback
    (`painting_compute.ts`), so the painted set is byte-identical across paths.

    Striped over target rows to bound the summed-area-table temporary to one
    stripe's image rows. At ratio <= 1 every block is a single voxel
    (`ix_lo == ix_hi`, `iy_lo == iy_hi`), `total == 1`, `min_pass == 1`, so this
    reduces bit-for-bit to `footprint & (image in [low, high])`.
    """
    t_sy = inside.shape[0]
    # Per-column block widths in image voxels (length t_sx).
    bw = ix_hi - ix_lo + 1
    for ys in range(0, t_sy, _FOOTPRINT_STRIPE_ROWS):
        ye = min(ys + _FOOTPRINT_STRIPE_ROWS, t_sy)
        stripe = inside[ys:ye]
        if not bool(stripe.any()):
            continue
        # Image rows this target-row stripe covers (bounds are monotonic in j).
        r0 = int(iy_lo[ys])
        r1 = int(iy_hi[ye - 1])
        sub = image[r0 : r1 + 1, :]
        band = (sub >= thr_low) & (sub <= thr_high)
        # Summed-area table padded by a zero row/col: sat[a, b] = sum of
        # band[0:a, 0:b]. int64 keeps exact counts for any block size.
        sat = np.zeros((band.shape[0] + 1, band.shape[1] + 1), dtype=np.int64)
        np.cumsum(np.cumsum(band, axis=0, dtype=np.int64), axis=1, out=sat[1:, 1:])
        # Stripe-local y block bounds and heights.
        yl = iy_lo[ys:ye] - r0
        yh = iy_hi[ys:ye] - r0
        bh = yh - yl + 1
        # Block in-band counts for every (j in stripe, i) via the four SAT
        # corners (broadcast over the stripe × target-x grid).
        pass_count = (
            sat[np.ix_(yh + 1, ix_hi + 1)]
            - sat[np.ix_(yl, ix_hi + 1)]
            - sat[np.ix_(yh + 1, ix_lo)]
            + sat[np.ix_(yl, ix_lo)]
        )
        total = np.outer(bh, bw)
        min_pass = np.ceil(coverage * total).astype(np.int64)
        np.clip(min_pass, 1, total, out=min_pass)
        stripe &= pass_count >= min_pass


def apply_paint_pipeline(
    image_bytes,
    i_sx,
    i_sy,
    image_data_type,
    lo_image_x,
    lo_image_y,
    lo_tx,
    lo_ty,
    t_sx,
    t_sy,
    sx_ratio,
    sy_ratio,
    thr_low,
    thr_high,
    coverage_threshold,
    path_points,
    radius,
    binary_closing_iterations,
    min_component_size,
    filter_components_first,
):
    """Whole masked-brush compute for one z-slice (TM-317).

    Replicates `painting_compute.ts::stampShape2DMasked` end-to-end in numpy:
    for each target voxel, gather the image BLOCK it covers (`[floor(v·ratio),
    ceil((v+1)·ratio) - 1]` per axis, TM-339), paint iff at least
    `coverage_threshold` of that block is inside `[thr_low, thr_high]`, gate by
    the swept-capsule footprint, then run binary closing + min-component-size
    filtering in the ordering selected by `filter_components_first`. At
    ratio ≤ 1 the block is a single voxel and this matches the legacy
    nearest-neighbour threshold bit-for-bit.

    Args:
        image_bytes: JS native-dtype image slab (PyProxy), row-major (x fast)
            over `[lo_image_x, lo_image_x + i_sx) x [lo_image_y, lo_image_y + i_sy)`.
        i_sx, i_sy: image slab dimensions.
        image_data_type: JS dtype string for the slab.
        lo_image_x, lo_image_y: image-voxel origin of the slab.
        lo_tx, lo_ty: target footprint origin (target voxel coords).
        t_sx, t_sy: target footprint dimensions.
        sx_ratio, sy_ratio: target->image nm ratios (target_size_nm / image_size_nm).
        thr_low, thr_high: inclusive threshold band.
        coverage_threshold: fraction (0, 1] of a target voxel's covered image
            block that must be in-band to paint it. 0.5 = majority. Only matters
            when a ratio > 1 (target coarser than image); at ratio <= 1 the block
            is one voxel and this reduces to the plain in-band test.
        path_points: flattened [x0, y0, x1, y1, ...] un-floored target voxel
            coords of the swept-capsule polyline.
        radius: brush radius in target voxels (already floored).
        binary_closing_iterations: closing iterations; 0 disables.
        min_component_size: minimum kept component size; <= 1 disables.
        filter_components_first: True -> filter then close; False -> close then
            filter.

    Returns:
        A `bytes` object of 0/1 (uint8), row-major (x fast), length t_sx * t_sy:
        the footprint voxels to paint (1) vs skip (0).
    """
    global last_pipeline_timings_json
    t0 = time.perf_counter()
    image_dtype = _numpy_dtype(image_data_type)
    image = np.frombuffer(image_bytes.to_py(), dtype=image_dtype).reshape((i_sy, i_sx))
    pts = np.asarray(path_points.to_py(), dtype=np.float64).reshape((-1, 2))
    t1 = time.perf_counter()

    # Resample: per-axis image BLOCK each target voxel covers (TM-339). A target
    # voxel at absolute coord `v` spans image voxels
    # `[floor(v·ratio), ceil((v+1)·ratio) - 1]`; both bounds use the same
    # floor/ceil as JS, then made slab-local. The main thread sizes the slab to
    # exactly span these blocks, so no clipping is needed. At ratio <= 1 the
    # block collapses to one voxel (lo == hi) and coverage reduces to the plain
    # in-band test. These per-axis arrays are tiny (length t_sx / t_sy); the
    # gather happens only over footprint voxels inside the coverage pass.
    tm = time.perf_counter()
    radius = int(radius)
    tx = lo_tx + np.arange(t_sx, dtype=np.float64)
    ty = lo_ty + np.arange(t_sy, dtype=np.float64)
    ix_lo = np.floor(tx * sx_ratio).astype(np.int64) - lo_image_x
    ix_hi = np.ceil((tx + 1.0) * sx_ratio).astype(np.int64) - 1 - lo_image_x
    iy_lo = np.floor(ty * sy_ratio).astype(np.int64) - lo_image_y
    iy_hi = np.ceil((ty + 1.0) * sy_ratio).astype(np.int64) - 1 - lo_image_y

    r2 = float(radius) * float(radius)
    combined = _footprint_mask(tx, ty, lo_tx, lo_ty, pts, radius, r2)
    _threshold_footprint_coverage_inplace(
        combined, image, ix_lo, ix_hi, iy_lo, iy_hi, thr_low, thr_high,
        coverage_threshold,
    )
    mask_build_ms = (time.perf_counter() - tm) * 1000.0

    closing_ms = 0.0
    components_ms = 0.0
    needs_morphology = binary_closing_iterations > 0 or min_component_size > 1
    if not needs_morphology:
        # Identity pipeline — stamp the raw threshold∧footprint mask (matches the
        # main-thread short-circuit).
        result = combined
    else:
        # Crop the morphology to the thresholded set bbox padded by the closing
        # reach. Byte-identical to the full-footprint pipeline: closing cannot
        # propagate past `closing` voxels, and with one guard ring the eroded
        # neighbourhoods match; the component filter only clears voxels. This is
        # the same crop the main-thread path applied (`stampShape2DMasked`), so it
        # turns a multi-million-voxel morphology into one over the (typically far
        # sparser) thresholded region.
        col_any = combined.any(axis=0)
        if not bool(col_any.any()):
            result = combined  # empty: closing/filtering of all-zero is identity
        else:
            row_any = combined.any(axis=1)
            i0 = int(col_any.argmax())
            i1 = t_sx - 1 - int(col_any[::-1].argmax())
            j0 = int(row_any.argmax())
            j1 = t_sy - 1 - int(row_any[::-1].argmax())
            pad = binary_closing_iterations + 1
            ci0 = max(0, i0 - pad)
            ci1 = min(t_sx - 1, i1 + pad)
            cj0 = max(0, j0 - pad)
            cj1 = min(t_sy - 1, j1 + pad)
            crop = combined[cj0 : cj1 + 1, ci0 : ci1 + 1].copy()
            if filter_components_first:
                tc = time.perf_counter()
                crop = filter_components(crop, min_component_size)
                components_ms = (time.perf_counter() - tc) * 1000.0
                if binary_closing_iterations > 0:
                    tc = time.perf_counter()
                    crop = binary_closing(crop, iterations=binary_closing_iterations)
                    closing_ms = (time.perf_counter() - tc) * 1000.0
            else:
                if binary_closing_iterations > 0:
                    tc = time.perf_counter()
                    crop = binary_closing(crop, iterations=binary_closing_iterations)
                    closing_ms = (time.perf_counter() - tc) * 1000.0
                tc = time.perf_counter()
                crop = filter_components(crop, min_component_size)
                components_ms = (time.perf_counter() - tc) * 1000.0
            # Paste the processed window back; outside it `combined` is all zero
            # by construction (the window covers every set voxel + closing reach).
            combined[cj0 : cj1 + 1, ci0 : ci1 + 1] = crop
            result = combined

    t2 = time.perf_counter()
    out = result.astype(np.uint8).tobytes()
    t3 = time.perf_counter()
    last_pipeline_timings_json = json.dumps(
        {
            "marshalInMs": (t1 - t0) * 1000.0,
            "maskBuildMs": mask_build_ms,
            "closingMs": closing_ms,
            "componentsMs": components_ms,
            "marshalOutMs": (t3 - t2) * 1000.0,
        }
    )
    return out
