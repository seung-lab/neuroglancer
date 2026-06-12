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
