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
 * Convert a position from the viewer's global coordinate space into absolute
 * voxel coordinates on a target scale's grid.
 *
 * The library's paint write path expects `BrushApplyInput.voxelPosition` in
 * the *target resolution's* voxel space, and it derives the session bounds and
 * pinned-chunk set by converting the region bbox through physical nanometers
 * into that same scale (`computeSessionVoxelBounds`). The viewer, however,
 * reports pointer positions (`mouseState.unsnappedPosition`) in
 * global-coordinate-space units whose per-axis physical size is
 * `globalScaleNm`. The two frames coincide only when the global resolution
 * equals the target resolution; when they differ (e.g. an annotation captured
 * at 8 nm painted onto a 16 nm target) the raw pointer values land in the
 * wrong frame, every painted voxel falls outside the session bounds and is
 * clipped, and the brush silently does nothing. Rescaling through nanometers
 * reconciles the frames:
 *
 *     targetVoxel[i] = globalPos[i] * globalScaleNm[i] / targetVoxelSizeNm[i]
 *
 * Inputs are per-axis (x, y, z). The result may be fractional — callers floor
 * as needed. When a target voxel size is zero or non-finite the axis is passed
 * through unscaled rather than producing `NaN` / `Infinity`.
 */
export function globalToTargetVoxel(
  globalPos: readonly [number, number, number],
  globalScaleNm: readonly [number, number, number],
  targetVoxelSizeNm: readonly [number, number, number],
): [number, number, number] {
  const axis = (i: number): number => {
    const denom = targetVoxelSizeNm[i];
    if (!Number.isFinite(denom) || denom === 0) return globalPos[i];
    return (globalPos[i] * globalScaleNm[i]) / denom;
  };
  return [axis(0), axis(1), axis(2)];
}
