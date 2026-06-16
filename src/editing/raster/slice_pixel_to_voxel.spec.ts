/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  slicePixelToGlobalPosition,
  slicePixelToTargetVoxel,
  type SliceProjectionInfo,
} from "#src/editing/raster/slice_pixel_to_voxel.js";
import { mat4 } from "#src/util/geom.js";

// invViewProjectionMat = T(center) * S(halfExtent): maps NDC (x,y,0) →
// (center + halfExtent*ndc). halfExtent is data units per NDC unit (= half the
// viewport's data extent along each axis).
function projMat(
  center: readonly [number, number, number],
  halfExtent: readonly [number, number, number],
): mat4 {
  const m = mat4.create();
  mat4.translate(m, m, center as [number, number, number]);
  mat4.scale(m, m, halfExtent as [number, number, number]);
  return m;
}

function baseProj(
  over: Partial<SliceProjectionInfo> = {},
): SliceProjectionInfo {
  return {
    invViewProjectionMat: projMat([50, 60, 70], [10, 20, 1]),
    width: 200,
    height: 200,
    logicalWidth: 200,
    logicalHeight: 200,
    visibleLeftFraction: 0,
    visibleTopFraction: 0,
    displayDimensionIndices: [0, 1, 2],
    displayRank: 3,
    ...over,
  };
}

function expectClose(a: ArrayLike<number>, b: readonly number[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], 9);
}

describe("slicePixelToGlobalPosition", () => {
  it("maps the viewport centre to the slice centre", () => {
    const pos = slicePixelToGlobalPosition(baseProj(), [0, 0, 0], 100, 100);
    expectClose(pos, [50, 60, 70]);
  });

  it("flips Y (top-of-panel → larger data Y)", () => {
    const top = slicePixelToGlobalPosition(baseProj(), [0, 0, 0], 100, 0);
    const bottom = slicePixelToGlobalPosition(baseProj(), [0, 0, 0], 100, 200);
    // ndcY = +1 at the top → center + halfExtent; -1 at the bottom.
    expect(top[1]).toBeCloseTo(80, 9); // 60 + 20*1
    expect(bottom[1]).toBeCloseTo(40, 9); // 60 + 20*(-1)
  });

  it("maps X linearly across the viewport", () => {
    const left = slicePixelToGlobalPosition(baseProj(), [0, 0, 0], 0, 100);
    const right = slicePixelToGlobalPosition(baseProj(), [0, 0, 0], 200, 100);
    expect(left[0]).toBeCloseTo(40, 9); // 50 + 10*(-1)
    expect(right[0]).toBeCloseTo(60, 9); // 50 + 10*(+1)
  });

  it("accounts for a clipped viewport (visibleLeftFraction)", () => {
    const proj = baseProj({ visibleLeftFraction: 0.25 });
    // glWindowX = 100 - 0.25*200 = 50 → ndcX = 2*50/200 - 1 = -0.5
    const pos = slicePixelToGlobalPosition(proj, [0, 0, 0], 100, 100);
    expect(pos[0]).toBeCloseTo(45, 9); // 50 + 10*(-0.5)
  });

  it("preserves non-displayed dimensions and output rank", () => {
    const proj = baseProj({
      displayDimensionIndices: [0, 2],
      displayRank: 2,
    });
    const pos = slicePixelToGlobalPosition(proj, [1, 2, 3, 4], 100, 100);
    // Display dims 0 and 2 overwritten with center; dims 1 and 3 preserved.
    expect(pos.length).toBe(4);
    expect(pos[0]).toBeCloseTo(50, 9);
    expect(pos[1]).toBeCloseTo(2, 9);
    expect(pos[2]).toBeCloseTo(60, 9); // halfExtent[1] applies to 2nd display axis
    expect(pos[3]).toBeCloseTo(4, 9);
  });

  it("does not mutate navPosition", () => {
    const nav = [1, 2, 3];
    slicePixelToGlobalPosition(baseProj(), nav, 0, 0);
    expect(nav).toEqual([1, 2, 3]);
  });
});

describe("slicePixelToTargetVoxel", () => {
  it("rescales the global position through nanometres to the target grid", () => {
    // Centre pixel → global [50,60,70]; at 8nm global vs 16nm target the XY
    // axes halve, Z (40nm == 40nm) is unchanged.
    const voxel = slicePixelToTargetVoxel(
      baseProj(),
      [0, 0, 0],
      100,
      100,
      [8, 8, 40],
      [16, 16, 40],
    );
    expectClose(voxel, [25, 30, 70]);
  });

  it("equals the global position when global and target scales match", () => {
    const voxel = slicePixelToTargetVoxel(
      baseProj(),
      [0, 0, 0],
      0,
      200,
      [8, 8, 40],
      [8, 8, 40],
    );
    // left/bottom pixel: x = 40, y = 40, z = 70.
    expectClose(voxel, [40, 40, 70]);
  });
});
