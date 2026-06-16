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
 * Pure-TS twin of `python_painter.py::apply_paint_pipeline` (TM-317).
 *
 * The production whole-pipeline path runs in pyodide (numpy/scipy). This twin
 * mirrors that python line-for-line on the JS side using the shared TS
 * morphology kernel (`applyMorphologyPipeline`), exactly as
 * `mask_compute.ts`'s `applyMorphologyPipeline` mirrors `apply_morphology`.
 * It serves two roles:
 *
 *  1. Parity reference — the matrix spec injects it as the worker stand-in and
 *     asserts the new routing produces a batch byte-identical to the current
 *     main-thread masked compute.
 *  2. Cross-check target — the live-pyodide spec asserts the real python output
 *     equals this twin, closing the "is the worker truly bit-identical" gap.
 *
 * It is NOT used as the production fallback: when the worker is unavailable the
 * masked brush stays on the original `stampShape2DMasked` main-thread path.
 */

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import type { PaintPipelineRequest } from "#src/editing/tool_runtimes/paint_pipeline_request.js";

/**
 * Squared distance from `(px, py)` to segment `a→b`, projection clamped to
 * `[0, 1]`. Byte-for-byte twin of `painting_compute.ts::segmentDistanceSq`
 * (and `python_painter.py::_footprint_mask`). A degenerate segment (`a === b`)
 * yields the squared distance to the point.
 */
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

/**
 * Compute the footprint mask the worker would return for `req`: resample →
 * threshold → swept-capsule gate → morphology. Returns a `Uint8Array` of length
 * `tSx * tSy`, row-major (x fastest), 1 = paint.
 */
export function runPaintPipelineTS(req: PaintPipelineRequest): Uint8Array {
  const [iSx] = req.imageShape;
  const [tSx, tSy] = req.targetShape;
  const image = req.image;
  const pts = req.pathPoints;
  const nPoints = pts.length >> 1;
  const nSegments = Math.max(1, nPoints - 1);
  const r2 = req.radius * req.radius;
  const low = req.thresholdLow;
  const high = req.thresholdHigh;

  const combined = new Uint8Array(tSx * tSy);
  for (let j = 0; j < tSy; j++) {
    const vy = req.loTy + j;
    const iy = Math.floor(vy * req.syRatio) - req.loImageY;
    for (let i = 0; i < tSx; i++) {
      const vx = req.loTx + i;
      // Footprint: union of the per-segment capsules.
      let inShape = false;
      for (let k = 0; k < nSegments; k++) {
        const ax = pts[2 * k];
        const ay = pts[2 * k + 1];
        const bx = nPoints > 1 ? pts[2 * k + 2] : ax;
        const by = nPoints > 1 ? pts[2 * k + 3] : ay;
        if (segmentDistanceSq(vx, vy, ax, ay, bx, by) <= r2) {
          inShape = true;
          break;
        }
      }
      if (!inShape) continue;
      const ix = Math.floor(vx * req.sxRatio) - req.loImageX;
      const v = image[ix + iSx * iy];
      if (v >= low && v <= high) combined[i + tSx * j] = 1;
    }
  }

  return applyMorphologyPipeline({
    mask: { data: combined, shape: [tSx, tSy, 1] },
    binaryClosing: req.binaryClosing,
    minComponentSize: req.minComponentSize,
    filterComponentsFirst: req.filterComponentsFirst,
  }).data;
}
