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

import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";

describe("globalToTargetVoxel", () => {
  it("is the identity when global resolution equals target resolution", () => {
    // Global units are 8 nm/voxel and the target is also 8 nm/voxel, so the
    // pointer position passes through unchanged — this is the case that always
    // worked before the fix.
    const out = globalToTargetVoxel([100, 200, 50], [8, 8, 40], [8, 8, 40]);
    expect(out).toEqual([100, 200, 50]);
  });

  it("downscales when the target is coarser than the global frame", () => {
    // Global frame is 8 nm; target layer is 16 nm. A global voxel at 100 maps
    // to physical 800 nm, which is voxel 50 on the 16 nm grid.
    const out = globalToTargetVoxel([100, 100, 10], [8, 8, 40], [16, 16, 40]);
    expect(out).toEqual([50, 50, 10]);
  });

  it("upscales when the target is finer than the global frame", () => {
    // Global frame is 16 nm; target layer is 8 nm. A global voxel at 50 maps
    // to physical 800 nm, which is voxel 100 on the 8 nm grid.
    const out = globalToTargetVoxel([50, 50, 10], [16, 16, 40], [8, 8, 40]);
    expect(out).toEqual([100, 100, 10]);
  });

  it("scales each axis independently (anisotropic resolutions)", () => {
    const out = globalToTargetVoxel([100, 100, 100], [4, 4, 40], [8, 16, 40]);
    expect(out).toEqual([50, 25, 100]);
  });

  it("preserves fractional sub-voxel positions", () => {
    const out = globalToTargetVoxel([10.5, 0, 0], [8, 8, 40], [16, 16, 40]);
    expect(out[0]).toBeCloseTo(5.25, 10);
  });

  it("passes an axis through unscaled when the target voxel size is invalid", () => {
    const out = globalToTargetVoxel(
      [100, 200, 300],
      [8, 8, 40],
      [0, Number.NaN, 40],
    );
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(200);
    expect(out[2]).toBe(300);
  });
});
