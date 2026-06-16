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
 * Synchronous slice-panel pixel → voxel transform (TM-320).
 *
 * Painting input must run at the full pointer event rate, but
 * `mouseState.unsnappedPosition` is populated by an asynchronous GPU pick pass
 * that lags one frame — so a `pointermove` handler that reads it sees stale
 * positions and silently drops sub-frame (coalesced) samples. For a 2D slice
 * (cross-section) view the mapping from a panel pixel to the slice plane is a
 * pure CPU transform that needs no GPU, so we can compute it immediately for
 * every coalesced sample.
 *
 * This mirrors `SliceViewPanel.completePickRequest` (sliceview/panel.ts) and the
 * pixel→GL-window mapping in `RenderedDataPanel` (rendered_data_panel.ts):
 *
 *   glWindowX = mouseX - visibleLeftFraction * logicalWidth
 *   glWindowY = height - (mouseY - visibleTopFraction * logicalHeight)   // GL is bottom-up
 *   ndc      = (2*glWindow / size) - 1
 *   data     = invViewProjectionMat * (ndcX, ndcY, 0)
 *
 * `mouseX` / `mouseY` are panel-relative CSS pixels (the units the panel itself
 * uses); all the viewport fields are in those same units in normal (non-
 * screenshot) operation, so the NDC ratios are device-pixel-ratio independent.
 *
 * The result is the viewer's full-rank global position with the displayed
 * dimensions overwritten by the slice-plane intersection — identical to what
 * the pick pass would eventually write to `mouseState.unsnappedPosition`, only
 * synchronous. Callers rescale to a tool's target voxel grid with
 * {@link globalToTargetVoxel}; {@link slicePixelToTargetVoxel} does both.
 */

import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";
import type { mat4 } from "#src/util/geom.js";
import { vec3 } from "#src/util/geom.js";

/**
 * The subset of a slice panel's projection + viewport state needed to map a
 * pixel to the slice plane. All viewport fields are panel-relative CSS pixels
 * (from `RenderedDataPanel.renderViewport`); `invViewProjectionMat`,
 * `displayDimensionIndices`, and `displayRank` come from the slice view's
 * `projectionParameters` (`invViewProjectionMat`, `displayDimensionRenderInfo`).
 */
export interface SliceProjectionInfo {
  readonly invViewProjectionMat: mat4;
  /** Visible viewport size (renderViewport.width / .height). */
  readonly width: number;
  readonly height: number;
  /** Logical (unclipped) viewport size (renderViewport.logicalWidth / .logicalHeight). */
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly visibleLeftFraction: number;
  readonly visibleTopFraction: number;
  /** Global dimension index for each displayed axis (displayDimensionRenderInfo). */
  readonly displayDimensionIndices: ArrayLike<number>;
  readonly displayRank: number;
}

const scratch = vec3.create();

/**
 * Map a panel-relative pixel (`mouseX`, `mouseY` in CSS px) to the viewer's
 * full-rank global position, with displayed dimensions set to the slice-plane
 * intersection. `navPosition` supplies the non-displayed dimensions (and the
 * output rank); it is not mutated.
 */
export function slicePixelToGlobalPosition(
  proj: SliceProjectionInfo,
  navPosition: ArrayLike<number>,
  mouseX: number,
  mouseY: number,
): Float64Array {
  const glWindowX = mouseX - proj.visibleLeftFraction * proj.logicalWidth;
  // GL window coordinates are bottom-up; DOM/panel mouseY is top-down.
  const glWindowY =
    proj.height - (mouseY - proj.visibleTopFraction * proj.logicalHeight);
  scratch[0] = (2.0 * glWindowX) / proj.width - 1.0;
  scratch[1] = (2.0 * glWindowY) / proj.height - 1.0;
  scratch[2] = 0;
  vec3.transformMat4(scratch, scratch, proj.invViewProjectionMat);
  const pos = Float64Array.from(navPosition);
  const { displayDimensionIndices, displayRank } = proj;
  for (let i = 0; i < displayRank; ++i) {
    pos[displayDimensionIndices[i]] = scratch[i];
  }
  return pos;
}

/**
 * Map a panel-relative pixel to a tool's target-resolution voxel coordinates:
 * {@link slicePixelToGlobalPosition} followed by the global→target nanometre
 * rescale ({@link globalToTargetVoxel}) over the first three axes. Mirrors how
 * `PointerEventBridge.resolveVoxelPosition` treats `mouseState` positions, so a
 * synchronous slice sample lands on exactly the same voxel the pick pass would.
 */
export function slicePixelToTargetVoxel(
  proj: SliceProjectionInfo,
  navPosition: ArrayLike<number>,
  mouseX: number,
  mouseY: number,
  globalScaleNm: readonly [number, number, number],
  targetVoxelSizeNm: readonly [number, number, number],
): [number, number, number] {
  const pos = slicePixelToGlobalPosition(proj, navPosition, mouseX, mouseY);
  return globalToTargetVoxel(
    [pos[0], pos[1], pos[2]],
    globalScaleNm,
    targetVoxelSizeNm,
  );
}
