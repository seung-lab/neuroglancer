/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Worker-safe stroke rasterization kernel (TM-322 phase 3).
 *
 * Rasterizes an unmasked capsule / polyline brush stroke (single z-slice,
 * radius ≥ 1) directly into ONE chunk's dense voxel buffer, writing the brush
 * `value` at every covered voxel and leaving the rest untouched (the chunk
 * already holds the materialized baseline). This is the per-tile unit of work
 * the brush worker pool runs: each chunk is rasterized independently into its
 * own (SharedArrayBuffer-backed) `slot.data`, so tiles never touch overlapping
 * memory.
 *
 * It is intentionally dependency-free (no `@zettaai/edit-session`, no DOM) so it
 * can run unchanged on the main thread and inside the worker bundle. The
 * coverage test and per-segment bounding boxes match `painting_compute.ts`'s
 * `stampCapsule2D` / `rasterizePolylineFootprint` exactly, so a stroke
 * rasterized tile-by-tile here is identical to the legacy single-pass output.
 *
 * Chunk memory layout is x-fastest — `idx = (z*sizeY + y)*sizeX + x` — matching
 * the library's `voxelOffsetInBlock` (edit-session `shared/voxel-grid`).
 */

export type Vec3 = readonly [number, number, number];

/** The typed-array views a chunk's `slot.data` can be (edit-session ChunkVoxelBuffer). */
export type VoxelView =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | BigUint64Array
  | BigInt64Array;

export interface RasterizeStrokeParams {
  /** Polyline points in global voxel coords; all share one z-slice. */
  readonly points: readonly Vec3[];
  /** Brush radius in voxels (matches `Math.max(0, Math.floor(radius))`). */
  readonly radius: number;
  /** Value written at covered voxels (bigint for 64-bit views). */
  readonly value: number | bigint;
  /** Global voxel coord of this chunk's local (0,0,0). */
  readonly chunkOrigin: Vec3;
  /** Chunk dimensions `[sx, sy, sz]` in voxels. */
  readonly chunkSize: Vec3;
}

/** Chunk-local bounding box of the voxels a rasterize wrote. */
export interface RasterizedSubregion {
  readonly origin: Vec3;
  readonly size: Vec3;
}

/** Squared distance from `(px,py)` to segment `a→b`, clamped to the ends. */
function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

function isBigIntView(view: VoxelView): view is BigUint64Array | BigInt64Array {
  return view instanceof BigUint64Array || view instanceof BigInt64Array;
}

/**
 * Rasterize the stroke into `view`. Returns the chunk-local bbox of written
 * voxels, or undefined when nothing was written (the stroke misses this chunk
 * in X/Y or Z, or `shouldCancel` fired). `shouldCancel` is polled once per row
 * so a superseded job stops promptly; any voxels written before a cancel are
 * irrelevant because the caller discards the (to-be-rolled-back) edit.
 */
export function rasterizeStrokeIntoChunk(
  view: VoxelView,
  params: RasterizeStrokeParams,
  shouldCancel?: () => boolean,
): RasterizedSubregion | undefined {
  const { points, radius, value, chunkOrigin, chunkSize } = params;
  if (points.length === 0) return undefined;
  const r = Math.max(0, Math.floor(radius));
  const r2 = r * r;
  const [ox, oy, oz] = chunkOrigin;
  const [sx, sy, sz] = chunkSize;

  // Single z-slice: bail if it falls outside this chunk.
  const cz = Math.floor(points[0][2]);
  const lz = cz - oz;
  if (lz < 0 || lz >= sz) return undefined;
  const zBase = lz * sy;

  const big = isBigIntView(view);
  const bigValue = big ? BigInt(value) : 0n;
  const numValue = big ? 0 : Number(value);

  // Chunk's global voxel extent (inclusive).
  const chunkLoX = ox;
  const chunkHiX = ox + sx - 1;
  const chunkLoY = oy;
  const chunkHiY = oy + sy - 1;

  let wLoX = Number.POSITIVE_INFINITY;
  let wLoY = Number.POSITIVE_INFINITY;
  let wHiX = Number.NEGATIVE_INFINITY;
  let wHiY = Number.NEGATIVE_INFINITY;

  // A single point is a degenerate segment (a disk); otherwise iterate the
  // union of consecutive-segment capsules. Overlapping writes are idempotent.
  const segCount = points.length === 1 ? 1 : points.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = points[s];
    const b = points.length === 1 ? a : points[s + 1];
    const ax = a[0];
    const ay = a[1];
    const bx = b[0];
    const by = b[1];
    // Per-segment bbox (matches stampCapsule2D), clipped to this chunk.
    const segLoX = Math.max(chunkLoX, Math.floor(Math.min(ax, bx)) - r);
    const segHiX = Math.min(chunkHiX, Math.ceil(Math.max(ax, bx)) + r);
    const segLoY = Math.max(chunkLoY, Math.floor(Math.min(ay, by)) - r);
    const segHiY = Math.min(chunkHiY, Math.ceil(Math.max(ay, by)) + r);
    for (let vy = segLoY; vy <= segHiY; vy++) {
      if (shouldCancel?.()) return undefined;
      const rowBase = (zBase + (vy - oy)) * sx;
      for (let vx = segLoX; vx <= segHiX; vx++) {
        if (segmentDistanceSq(vx, vy, ax, ay, bx, by) > r2) continue;
        const idx = rowBase + (vx - ox);
        if (big) {
          (view as BigUint64Array)[idx] = bigValue;
        } else {
          (view as Uint8Array)[idx] = numValue;
        }
        if (vx < wLoX) wLoX = vx;
        if (vx > wHiX) wHiX = vx;
        if (vy < wLoY) wLoY = vy;
        if (vy > wHiY) wHiY = vy;
      }
    }
  }

  if (wHiX < wLoX) return undefined; // nothing covered within this chunk
  return {
    origin: [wLoX - ox, wLoY - oy, lz],
    size: [wHiX - wLoX + 1, wHiY - wLoY + 1, 1],
  };
}

/** A precomputed footprint mask to stamp into chunks (masked-brush worker route). */
export interface StampMaskParams {
  /**
   * Footprint mask, `1` = paint. Dense, x-fastest, over the box
   * `[loTx, loTx+maskW) × [loTy, loTy+maskH)` on z-slice `cz` (GLOBAL voxel
   * coords). This is the exact mask the pyodide whole-pipeline returns, so the
   * stamp is byte-identical to the main-thread `writeVoxel` sample-back loop.
   */
  readonly mask: Uint8Array;
  readonly maskW: number;
  readonly maskH: number;
  readonly loTx: number;
  readonly loTy: number;
  readonly cz: number;
  /** Value written at masked voxels (bigint for 64-bit views). */
  readonly value: number | bigint;
  /** Global voxel coord of this chunk's local (0,0,0). */
  readonly chunkOrigin: Vec3;
  /** Chunk dimensions `[sx, sy, sz]` in voxels. */
  readonly chunkSize: Vec3;
}

/**
 * Stamp a precomputed footprint mask into ONE chunk's dense voxel buffer:
 * write `value` at every voxel inside the footprint box where the mask bit is
 * set, leaving the rest untouched (the chunk already holds the materialized
 * baseline). Returns the chunk-local bbox of written voxels, or undefined when
 * the footprint misses this chunk (in X/Y or Z, or all-zero overlap) or
 * `shouldCancel` fired.
 *
 * This is the masked analogue of `rasterizeStrokeIntoChunk` and the worker unit
 * of work for the masked brush (TM-317 Phase B): it fuses the main-thread
 * `scatter` (sample-back) and `writeRegion` (slot scatter) into a single
 * off-thread pass over the footprint∩chunk intersection. The result is
 * byte-identical to scattering the same mask through `builder.writeVoxel` +
 * `writeRegion`, because both write exactly `{value @ mask=1}`.
 */
export function stampMaskIntoChunk(
  view: VoxelView,
  params: StampMaskParams,
  shouldCancel?: () => boolean,
): RasterizedSubregion | undefined {
  const { mask, maskW, maskH, loTx, loTy, cz, value, chunkOrigin, chunkSize } =
    params;
  const [ox, oy, oz] = chunkOrigin;
  const [sx, sy, sz] = chunkSize;

  // Single z-slice: bail if it falls outside this chunk.
  const lz = cz - oz;
  if (lz < 0 || lz >= sz) return undefined;
  const zBase = lz * sy;

  // Intersection of the footprint box with this chunk, in global coords.
  const x0 = Math.max(ox, loTx);
  const x1 = Math.min(ox + sx - 1, loTx + maskW - 1);
  const y0 = Math.max(oy, loTy);
  const y1 = Math.min(oy + sy - 1, loTy + maskH - 1);
  if (x0 > x1 || y0 > y1) return undefined;

  const big = isBigIntView(view);
  const bigValue = big ? BigInt(value) : 0n;
  const numValue = big ? 0 : Number(value);

  let wLoX = Number.POSITIVE_INFINITY;
  let wLoY = Number.POSITIVE_INFINITY;
  let wHiX = Number.NEGATIVE_INFINITY;
  let wHiY = Number.NEGATIVE_INFINITY;

  for (let vy = y0; vy <= y1; vy++) {
    if (shouldCancel?.()) return undefined;
    const maskRow = (vy - loTy) * maskW;
    const slotRow = (zBase + (vy - oy)) * sx;
    for (let vx = x0; vx <= x1; vx++) {
      if (mask[maskRow + (vx - loTx)] !== 1) continue;
      const idx = slotRow + (vx - ox);
      if (big) {
        (view as BigUint64Array)[idx] = bigValue;
      } else {
        (view as Uint8Array)[idx] = numValue;
      }
      if (vx < wLoX) wLoX = vx;
      if (vx > wHiX) wHiX = vx;
      if (vy < wLoY) wLoY = vy;
      if (vy > wHiY) wHiY = vy;
    }
  }

  if (wHiX < wLoX) return undefined; // mask was all-zero within this chunk
  return {
    origin: [wLoX - ox, wLoY - oy, lz],
    size: [wHiX - wLoX + 1, wHiY - wLoY + 1, 1],
  };
}
