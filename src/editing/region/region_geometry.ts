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
 * @file Pure geometry helpers for the session-owned edit-region overlays
 * (TM-302). Kept free of GL/viewer dependencies so they are unit-testable.
 */

import type { vec3 } from "#src/util/geom.js";

export const BOX_EDGES = 12;
export const BOX_EDGE_VERTEX_COUNT = BOX_EDGES * 2;

/**
 * Vertices of the unit cube's 12 edges, laid out as `gl.LINES` pairs
 * (24 vertices × 3 components). Every coordinate is 0 or 1; the overlay
 * shader maps them onto the region via `mix(uBoxLo, uBoxHi, corner)`.
 */
export function buildUnitBoxEdgeVertices(): Float32Array {
  const out = new Float32Array(BOX_EDGE_VERTEX_COUNT * 3);
  let off = 0;
  const corner = [0, 0, 0];
  // For each axis, the 4 edges running along that axis (one per combination
  // of the other two axes' 0/1 values).
  for (let axis = 0; axis < 3; ++axis) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let i = 0; i < 2; ++i) {
      for (let j = 0; j < 2; ++j) {
        corner[u] = i;
        corner[v] = j;
        corner[axis] = 0;
        out[off++] = corner[0];
        out[off++] = corner[1];
        out[off++] = corner[2];
        corner[axis] = 1;
        out[off++] = corner[0];
        out[off++] = corner[1];
        out[off++] = corner[2];
      }
    }
  }
  return out;
}

/**
 * Returns a copy of `position` (full-rank global coordinates) with the
 * display-dimension coordinates set to the center of the box `[lo, hi]`.
 * Box axis `i` corresponds to global dimension `displayDimensionIndices[i]`;
 * indices of `-1` (unused display dimensions) are skipped, and non-display
 * coordinates (e.g. `t`) are left untouched.
 */
export function positionAtBoxCenter(
  position: Float32Array,
  displayDimensionIndices: Int32Array,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
): Float32Array {
  const out = Float32Array.from(position);
  for (let i = 0; i < 3; ++i) {
    const dim = displayDimensionIndices[i];
    if (dim === undefined || dim < 0 || dim >= out.length) continue;
    out[dim] = (lo[i] + hi[i]) / 2;
  }
  return out;
}

/**
 * Like {@link positionAtBoxCenter}, but snaps each display-dimension coordinate
 * to the CENTER of a voxel the region actually covers, rather than the
 * geometric midpoint.
 *
 * Why this matters: the paint write path maps a continuous position to a voxel
 * index with `floor`, and the library clips writes to the integer voxel range
 * `[floor(lo), floor(hi))`. The geometric midpoint can land on a voxel
 * boundary — e.g. a one-voxel-thick z-slab `[920.5, 921.5]` has midpoint
 * `921.0`, which `floor`s to voxel 921, but the only covered voxel is
 * `floor(920.5) = 920`. The slice then shows an in-region box while every
 * stroke is silently clipped. Centering on `coveredCenterVoxel + 0.5`
 * guarantees `floor(position)` is an in-region voxel, so the first stroke
 * lands and z-stepping stays on clean voxel centers.
 *
 * The covered integer range per axis is `[floor(lo), floor(hi))` (half-open,
 * matching the library); the chosen voxel is the lower-middle of that range,
 * clamped so a degenerate (sub-voxel) span still yields `floor(lo)`.
 */
export function voxelCenterInBox(
  position: Float32Array,
  displayDimensionIndices: Int32Array,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
): Float32Array {
  const out = Float32Array.from(position);
  for (let i = 0; i < 3; ++i) {
    const dim = displayDimensionIndices[i];
    if (dim === undefined || dim < 0 || dim >= out.length) continue;
    const loVoxel = Math.floor(lo[i]);
    // Last covered voxel: `floor(hi) - 1` for a half-open range, but never
    // below `loVoxel` (degenerate spans thinner than one voxel).
    const hiVoxel = Math.max(loVoxel, Math.floor(hi[i]) - 1);
    const centerVoxel = Math.floor((loVoxel + hiVoxel) / 2);
    out[dim] = centerVoxel + 0.5;
  }
  return out;
}

/**
 * Snap a raw voxel bbox (the min/max of an annotation's corners) to whole
 * voxels, so the captured edit region aligns to the voxel grid.
 *
 * Native neuroglancer's bounding-box tool stores the *unsnapped* mouse position
 * and bumps any zero-thickness axis by `+1` (`PlaceBoundingBoxTool`). A box
 * drawn on a single slice at voxel `i` — whose center is `i + 0.5` for these
 * sources — therefore comes out as `[i + 0.5, i + 1.5]`: one voxel wide, but
 * offset half a voxel off the grid so it straddles voxels `i` and `i + 1`.
 * Downstream, the library clips writes to `[floor(lo), floor(hi))` (→ voxel
 * `i`) while the region outline and the geometric-center teleport drift toward
 * `i + 1` — so the region "covers" `i` yet visually reads as `i + 1`.
 *
 * Flooring both faces collapses the box back onto the voxel it was drawn on
 * (`floor(i + 0.5) = i`), keeping every axis at least one voxel thick. The
 * result is unambiguous: region, outline, library clip, and entry teleport all
 * agree on the same whole voxels. Already grid-aligned boxes are unchanged.
 */
export function snapVoxelBbox(
  raw: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const lo: [number, number, number] = [
    Math.floor(raw[0]),
    Math.floor(raw[1]),
    Math.floor(raw[2]),
  ];
  return [
    lo[0],
    lo[1],
    lo[2],
    // At least one voxel thick: a sub-voxel drag would otherwise floor to a
    // zero-width box that the library clips to nothing.
    Math.max(Math.floor(raw[3]), lo[0] + 1),
    Math.max(Math.floor(raw[4]), lo[1] + 1),
    Math.max(Math.floor(raw[5]), lo[2] + 1),
  ];
}

/**
 * Whether the plane `dot(planeNormal, p) == planeDistance` intersects the
 * axis-aligned box `[lo, hi]`. Computed from the min/max of the corner
 * projections accumulated per axis (no corner enumeration). The epsilon
 * mirrors `LAMBDA_EPSILON` in `src/sliceview/bounding_box_shader_helper.ts`
 * so this CPU early-out never culls a cross-section the shader would draw.
 */
export function planeIntersectsBox(
  lo: vec3,
  hi: vec3,
  planeNormal: vec3,
  planeDistance: number,
  epsilon = 1e-3,
): boolean {
  let min = 0;
  let max = 0;
  for (let axis = 0; axis < 3; ++axis) {
    const a = planeNormal[axis] * lo[axis];
    const b = planeNormal[axis] * hi[axis];
    min += Math.min(a, b);
    max += Math.max(a, b);
  }
  return planeDistance >= min - epsilon && planeDistance <= max + epsilon;
}
