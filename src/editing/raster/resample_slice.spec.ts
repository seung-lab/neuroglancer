/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  resampleNearestXY,
  type Grid2D,
} from "#src/editing/raster/resample_slice.js";

function grid(
  width: number,
  height: number,
  originX: number,
  originY: number,
  voxelNm: number,
): Grid2D {
  return {
    width,
    height,
    originX,
    originY,
    voxelSizeNmX: voxelNm,
    voxelSizeNmY: voxelNm,
  };
}

describe("resampleNearestXY", () => {
  it("returns an independent copy when the grids are identical", () => {
    const g = grid(2, 2, 0, 0, 8);
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleNearestXY(src, g, g);
    expect([...out]).toEqual([1, 2, 3, 4]);
    out[0] = 9;
    expect(src[0]).toBe(1); // not aliased
  });

  it("upsamples a coarse grid onto a 2× finer grid (nearest)", () => {
    // 2×2 @ 16nm → 4×4 @ 8nm, same origin: each source voxel fills a 2×2 block.
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleNearestXY(
      src,
      grid(2, 2, 0, 0, 16),
      grid(4, 4, 0, 0, 8),
    );
    expect([...out]).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
  });

  it("downsamples a fine grid onto a 2× coarser grid (nearest)", () => {
    // 4×4 @ 8nm → 2×2 @ 16nm: each dest samples the source voxel at its center.
    const src = Uint8Array.from([
      0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33,
    ]);
    const out = resampleNearestXY(
      src,
      grid(4, 4, 0, 0, 8),
      grid(2, 2, 0, 0, 16),
    );
    expect([...out]).toEqual([11, 13, 31, 33]);
  });

  it("honors differing origins and zero-fills out-of-bounds samples", () => {
    // Same resolution, dest shifted +1 voxel in X → column 1 falls off the source.
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleNearestXY(
      src,
      grid(2, 2, 0, 0, 8),
      grid(2, 2, 1, 0, 8),
    );
    expect([...out]).toEqual([2, 0, 4, 0]);
  });

  it("zero-fills a dest window fully outside the source", () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    const out = resampleNearestXY(
      src,
      grid(2, 2, 0, 0, 8),
      grid(2, 2, 100, 100, 8),
    );
    expect([...out]).toEqual([0, 0, 0, 0]);
  });
});
