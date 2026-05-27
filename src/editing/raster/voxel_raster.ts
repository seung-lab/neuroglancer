/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { VoxelAddress } from "#src/editing/raster/voxel_address.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";

/**
 * Paints a 2D disk-shaped brush footprint (XY plane, fixed Z) centered on
 * `center`, writing `value` into every patched voxel within Euclidean radius
 * `radius`. Handles chunks crossings transparently. Returns the number of
 * voxels written (zero if center is out of range or radius < 0).
 */
export function paintBrushDisk(
  patchStore: LocalPatchStore,
  center: VoxelAddress,
  radius: number,
  value: bigint,
): number {
  const r = Math.max(0, Math.floor(radius));
  const r2 = r * r;
  const { chunkDataSize } = center;
  const sx = chunkDataSize[0];
  const sy = chunkDataSize[1];
  const baseVx = center.chunkGridPosition[0] * sx + center.localOffset[0];
  const baseVy = center.chunkGridPosition[1] * sy + center.localOffset[1];
  let written = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const vx = baseVx + dx;
      const vy = baseVy + dy;
      const gx = Math.floor(vx / sx);
      const gy = Math.floor(vy / sy);
      const ox = vx - gx * sx;
      const oy = vy - gy * sy;
      // Build a chunkGridPosition that mirrors `center` but with the new
      // x/y grid coords. This preserves any extra (e.g. channel) dims.
      const gridPos = new Float32Array(center.chunkGridPosition);
      gridPos[0] = gx;
      gridPos[1] = gy;
      if (
        patchStore.source.writeVoxel(
          gridPos,
          chunkDataSize,
          ox,
          oy,
          center.localOffset[2],
          value,
        )
      ) {
        written++;
      }
    }
  }
  if (written > 0) patchStore.scheduleGPUFlush();
  return written;
}
