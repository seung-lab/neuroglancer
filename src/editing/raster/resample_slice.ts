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
 * @file Nearest-neighbor XY resampling of a dense slice between two voxel grids
 * that cover the SAME physical region at different resolutions (TM-326).
 *
 * Z-extrapolation runs the model at the image's grid, so the segmentation mask
 * (read at its own, possibly coarser, resolution) must be resampled onto the
 * image grid before it is sent, and the prediction resampled back onto the mask
 * grid before it is written. Both directions are the same operation: for every
 * destination voxel, sample the source voxel whose cell contains the
 * destination voxel's physical center.
 *
 * Nearest-neighbor (not interpolation) is mandatory: the buffers hold label /
 * segment values, which must never be blended. Coordinates are GLOBAL voxels
 * (absolute, `= physical / voxelSize`), so the two grids share a physical origin
 * and align by construction.
 */

/** One axis-aligned voxel grid over the region: a single-Z XY window + scale. */
export interface Grid2D {
  readonly width: number;
  readonly height: number;
  /** Global voxel of the window's lower-left corner (this grid's resolution). */
  readonly originX: number;
  readonly originY: number;
  /** Physical voxel size (nm) along X and Y at this grid's resolution. */
  readonly voxelSizeNmX: number;
  readonly voxelSizeNmY: number;
}

/**
 * Resample `src` (dense, X-fastest, laid out for `from`) onto the `to` grid by
 * nearest-neighbor. Destination voxels whose physical center falls outside the
 * source window read as 0.
 */
export function resampleNearestXY(
  src: Uint8Array,
  from: Grid2D,
  to: Grid2D,
): Uint8Array {
  if (gridsMatch(from, to)) {
    // Identical grid (equal resolution + window) — no resampling to do.
    return src.slice();
  }
  const out = new Uint8Array(to.width * to.height);
  for (let dstY = 0; dstY < to.height; dstY++) {
    const srcY = sampleAxis(
      dstY,
      to.originY,
      to.voxelSizeNmY,
      from.originY,
      from.voxelSizeNmY,
    );
    if (srcY < 0 || srcY >= from.height) continue;
    const srcRowBase = srcY * from.width;
    const outRowBase = dstY * to.width;
    for (let dstX = 0; dstX < to.width; dstX++) {
      const srcX = sampleAxis(
        dstX,
        to.originX,
        to.voxelSizeNmX,
        from.originX,
        from.voxelSizeNmX,
      );
      if (srcX < 0 || srcX >= from.width) continue;
      out[outRowBase + dstX] = src[srcRowBase + srcX];
    }
  }
  return out;
}

/** Source pixel index whose cell contains destination pixel `dstIndex`'s center. */
function sampleAxis(
  dstIndex: number,
  dstOrigin: number,
  dstVoxelSizeNm: number,
  srcOrigin: number,
  srcVoxelSizeNm: number,
): number {
  // Destination voxel center in physical nm, then which source voxel holds it.
  const centerNm = (dstOrigin + dstIndex + 0.5) * dstVoxelSizeNm;
  const srcGlobal = Math.floor(centerNm / srcVoxelSizeNm);
  return srcGlobal - srcOrigin;
}

function gridsMatch(a: Grid2D, b: Grid2D): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.voxelSizeNmX === b.voxelSizeNmX &&
    a.voxelSizeNmY === b.voxelSizeNmY
  );
}
