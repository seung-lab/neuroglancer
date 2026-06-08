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
 * @file Shared brush-cursor footprint geometry (TM-300).
 *
 * The painted brush is a 2-D disk in TARGET voxel-index space on the X/Y plane
 * at a fixed Z (`painting_compute.ts:stampDisk2D` — `dx² + dy² ≤ r²` over
 * integer voxel offsets). On an anisotropic grid the on-screen/physical
 * footprint of that disk is therefore an ELLIPSE whose two semi-axes come from
 * the two in-plane voxel sizes — not a circle, and not a single scalar.
 *
 * Both cursor overlays (slice + perspective) reduce voxel size to one number
 * (`Math.min` / `Math.max`), which is only correct when the in-plane axes are
 * isotropic. This module replaces that reduction with an orientation-agnostic
 * derivation: it emits the two painted-plane basis steps as DISPLAY-space
 * vectors (the frame `viewProjectionMat` consumes), scaled to the visual brush
 * radius. Overlays project those through the view matrix to obtain the exact
 * on-screen ellipse — correct for any per-layer resolution and for rotated /
 * oblique views.
 *
 * The display-space conversion mirrors `edit_session_host.ts`'s
 * `computeActiveRegionSync` `display()` helper:
 *
 *   displayDelta[i] = voxels × voxelSizeNm[dim] × 1e-9 / voxelPhysicalScales[i]
 *
 * where `dim = displayDimensionIndices[i]` and `voxelPhysicalScales[i]` is the
 * display dimension's voxel size in meters.
 */

import { Resolution } from "@zettaai/edit-session";

import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import { vec3 } from "#src/util/geom.js";

/**
 * The brush always stamps in the target layer's X/Y voxel plane at a fixed Z
 * (global dimensions 0 and 1). These are the two in-plane axes whose voxel
 * sizes define the ellipse semi-axes.
 */
const PAINTED_PLANE_GLOBAL_DIMS = [0, 1] as const;

export interface BrushFootprintAxes {
  /** Display-space semi-axis vector for the painted plane's X axis (global dim 0). */
  readonly offsetX: vec3;
  /** Display-space semi-axis vector for the painted plane's Y axis (global dim 1). */
  readonly offsetY: vec3;
}

/**
 * Visual radius of the painted footprint in voxels. The disk extends `radius`
 * voxels each side of the center voxel (diameter `2*radius + 1`), so the radius
 * that exactly bounds it is `radius + 0.5`. Matches the reference cursor's
 * `size/2` convention.
 */
export function visualRadiusVoxels(radiusVoxels: number): number {
  return radiusVoxels + 0.5;
}

/**
 * Compute the two painted-plane semi-axis vectors of the brush footprint, in
 * DISPLAY coordinates (the same frame as `worldCenter` /
 * `projectionParameters.viewProjectionMat`).
 *
 * Each painted-plane global dimension (X = 0, Y = 1) is mapped to its display
 * axis slot via `displayDimensionIndices`. A dimension that is not currently
 * displayed contributes a zero vector — i.e. the disk is edge-on along that
 * axis, which is physically correct. The returned vectors collapse to zero
 * length when the radius is non-positive or the resolution / scale is
 * unusable, letting callers skip drawing.
 */
export function computeBrushFootprintAxes(
  radiusVoxels: number,
  resolution: Resolution | undefined,
  displayInfo: DisplayDimensionRenderInfo,
): BrushFootprintAxes {
  const offsets: vec3[] = [vec3.create(), vec3.create()];
  const radius = visualRadiusVoxels(radiusVoxels);
  if (!Number.isFinite(radius) || radius <= 0) {
    return { offsetX: offsets[0], offsetY: offsets[1] };
  }

  // nm per voxel along each global axis; default to 1 nm when no resolution is
  // known (degenerate, but keeps the math finite for tests / detached state).
  const voxelSizeNm =
    resolution === undefined
      ? ([1, 1, 1] as const)
      : Resolution.toVoxelSize(resolution);

  const { displayDimensionIndices, voxelPhysicalScales, displayRank } =
    displayInfo;

  for (let axis = 0; axis < PAINTED_PLANE_GLOBAL_DIMS.length; ++axis) {
    const globalDim = PAINTED_PLANE_GLOBAL_DIMS[axis];
    // Find the display-axis slot rendering this global dimension.
    let slot = -1;
    for (let i = 0; i < displayRank && i < 3; ++i) {
      if (displayDimensionIndices[i] === globalDim) {
        slot = i;
        break;
      }
    }
    if (slot === -1) continue; // dimension not displayed → edge-on, zero extent.

    const scaleMeters = voxelPhysicalScales[slot];
    if (!Number.isFinite(scaleMeters) || scaleMeters <= 0) continue;

    const nm = voxelSizeNm[globalDim];
    if (!Number.isFinite(nm) || nm <= 0) continue;

    // Display-space length of `radius` voxels along this axis.
    offsets[axis][slot] = (radius * nm * 1e-9) / scaleMeters;
  }

  return { offsetX: offsets[0], offsetY: offsets[1] };
}
