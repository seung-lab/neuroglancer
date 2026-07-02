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
 * @file Pure overlap check between an edit region and a layer's data bounds
 * (TM-360). Kept free of viewer/host/UI dependencies so it is unit-testable.
 *
 * The whole point is to compare the region and the layer in the SAME physical
 * frame — absolute nanometres — never in raw voxel numbers. The region voxel
 * grid (the annotation's native `inputSpace`) and a layer's voxel grid (NG's
 * global voxel frame at each scale) can differ in both resolution and origin,
 * so raw-voxel comparisons are meaningless: e.g. a region at `4608 @ 80nm`
 * (≈ 369 µm) and a layer of size `2048 @ 8nm` (0 – 16 µm) never touch, yet the
 * bare numbers `4608` and `2048` look superficially close. Converting both
 * sides to nm first is what makes "does this layer hold data where the user
 * wants to paint?" answerable — and, historically, unasked (the contract was
 * deferred to the library's silent write-time clip; TM-317).
 */

import type {
  BoundingBoxVoxels,
  LayerMetadata,
  Resolution as ResolutionType,
} from "@zettaai/edit-session";
import { Resolution } from "@zettaai/edit-session";

import type { CoordinateSpace } from "#src/coordinate_transform.js";

/** Lower/upper corner of an axis-aligned box, in absolute physical nm. */
export interface NmBounds {
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
}

/**
 * How an edit region sits relative to a layer's data extent:
 * - `contains` — the region is fully inside the layer's data on all 3 axes.
 * - `partial`  — the region overlaps but pokes outside on at least one axis.
 * - `none`     — the region is fully disjoint on at least one axis; the layer
 *                holds no data anywhere in the region, so every paint write
 *                there clips to nothing.
 */
export type OverlapStatus = "contains" | "partial" | "none";

export interface LayerCompatResult {
  readonly status: OverlapStatus;
  /** The edit region, in nm — for a user-facing explanation. */
  readonly regionNm: NmBounds;
  /** The layer's data extent, in nm — for a user-facing explanation. */
  readonly layerNm: NmBounds;
}

/**
 * Per-axis voxel size in nm for the region's three spatial dimensions. A
 * `CoordinateSpace` always stores scales in SI metres, so this is a pure m→nm
 * conversion; the rounding strips the float noise that would otherwise make
 * the derived `Resolution` tag miss the layer's exact available resolutions.
 */
export function regionVoxelSizeNm(
  space: CoordinateSpace,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const nm = space.scales[i] * 1e9;
    out[i] = Math.round(nm * 1e6) / 1e6;
  }
  return out;
}

/** The library `Resolution` tag for a region frame, derived on demand. */
export function regionResolution(space: CoordinateSpace): ResolutionType {
  return Resolution.from(regionVoxelSizeNm(space));
}

/**
 * The edit region's extent in absolute physical nm. `bbox` is the region's
 * inclusive-exclusive voxel box; `regionSpace` gives the nm-per-voxel of that
 * grid.
 */
export function regionNmBounds(
  bbox: BoundingBoxVoxels,
  regionSpace: CoordinateSpace,
): NmBounds {
  const sizeNm = regionVoxelSizeNm(regionSpace);
  return {
    lo: [bbox[0] * sizeNm[0], bbox[1] * sizeNm[1], bbox[2] * sizeNm[2]],
    hi: [bbox[3] * sizeNm[0], bbox[4] * sizeNm[1], bbox[5] * sizeNm[2]],
  };
}

/**
 * A layer's data extent in absolute physical nm, unioned across every scale it
 * exposes. Each scale's `voxelOffset` is already the GLOBAL-frame origin (post
 * TM-317: `baseVoxelOffset + lowerVoxelBound`), so `offset × voxelSizeNm` and
 * `(offset + size) × voxelSizeNm` give the scale's physical corners directly.
 * Scales are physically coextensive, so the union is a safety net against
 * per-scale rounding rather than a real difference.
 */
export function layerNmBounds(metadata: LayerMetadata): NmBounds {
  const lo: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const hi: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const scale of metadata.scales) {
    for (let i = 0; i < 3; ++i) {
      const nm = scale.voxelSizeNm[i];
      const scaleLo = scale.voxelOffset[i] * nm;
      const scaleHi = (scale.voxelOffset[i] + scale.sizeVoxels[i]) * nm;
      if (scaleLo < lo[i]) lo[i] = scaleLo;
      if (scaleHi > hi[i]) hi[i] = scaleHi;
    }
  }
  return { lo, hi };
}

/**
 * Classify how `region` sits relative to `layer`, both in nm. Overlap on an
 * axis is the half-open test `regionLo < layerHi && layerLo < regionHi`; a
 * single disjoint axis makes the whole box disjoint (`none`).
 */
export function classifyOverlap(
  region: NmBounds,
  layer: NmBounds,
): OverlapStatus {
  let contained = true;
  for (let i = 0; i < 3; ++i) {
    const disjoint = region.lo[i] >= layer.hi[i] || layer.lo[i] >= region.hi[i];
    if (disjoint) return "none";
    if (region.lo[i] < layer.lo[i] || region.hi[i] > layer.hi[i]) {
      contained = false;
    }
  }
  return contained ? "contains" : "partial";
}

/**
 * Full compatibility check for one layer against the edit region. Returns the
 * status plus both nm extents so a caller can build an explanatory message
 * ("region spans … µm; layer covers … µm").
 */
export function checkLayerCompat(
  bbox: BoundingBoxVoxels,
  regionSpace: CoordinateSpace,
  metadata: LayerMetadata,
): LayerCompatResult {
  const regionNm = regionNmBounds(bbox, regionSpace);
  const layerNm = layerNmBounds(metadata);
  return { status: classifyOverlap(regionNm, layerNm), regionNm, layerNm };
}

/** Format an nm box as `lo–hi µm` per axis, for user-facing messages. */
export function formatNmBounds(bounds: NmBounds): string {
  const axis = (i: number) =>
    `${formatMicrons(bounds.lo[i])}–${formatMicrons(bounds.hi[i])}`;
  return `${axis(0)}, ${axis(1)}, ${axis(2)} µm`;
}

function formatMicrons(nm: number): string {
  if (!Number.isFinite(nm)) return "—";
  const um = nm / 1000;
  const abs = Math.abs(um);
  return um.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
}
