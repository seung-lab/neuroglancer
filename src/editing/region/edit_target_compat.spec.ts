/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerMetadata } from "@zettaai/edit-session";
import { layerId as toLayerId, Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import {
  checkLayerCompat,
  classifyOverlap,
  layerNmBounds,
  regionNmBounds,
  regionVoxelSizeNm,
} from "#src/editing/region/edit_target_compat.js";

/** A region `CoordinateSpace` at the given per-axis nm scale. */
function regionSpaceNm(x: number, y: number, z: number): CoordinateSpace {
  return makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: ["m", "m", "m"],
    // CoordinateSpace scales are SI metres.
    scales: Float64Array.of(x * 1e-9, y * 1e-9, z * 1e-9),
  });
}

/** A single-scale layer with the given nm/voxel, offset (voxels) and size. */
function layerMeta(opts: {
  voxelSizeNm: [number, number, number];
  voxelOffset: [number, number, number];
  sizeVoxels: [number, number, number];
}): LayerMetadata {
  return {
    layerId: toLayerId("seg"),
    voxelDataType: "uint8",
    channels: 1,
    scales: [
      {
        resolution: Resolution.from(opts.voxelSizeNm),
        voxelSizeNm: opts.voxelSizeNm,
        voxelOffset: opts.voxelOffset,
        sizeVoxels: opts.sizeVoxels,
        chunkDataSize: [64, 64, 64],
      },
    ],
  };
}

describe("regionVoxelSizeNm", () => {
  it("converts SI metres to nm", () => {
    expect(regionVoxelSizeNm(regionSpaceNm(80, 80, 45))).toEqual([80, 80, 45]);
  });

  it("rounds off float noise so the resolution tag stays exact", () => {
    // 8e-9 m stored as a slightly-off double must round back to 8 nm.
    const space = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(8.0000000001e-9, 8e-9, 40e-9),
    });
    expect(regionVoxelSizeNm(space)).toEqual([8, 8, 40]);
  });
});

describe("regionNmBounds", () => {
  it("scales the voxel bbox into absolute nm", () => {
    const bounds = regionNmBounds(
      [4608, 3840, 5304, 5376, 4608, 5305],
      regionSpaceNm(80, 80, 45),
    );
    expect(bounds.lo).toEqual([368640, 307200, 238680]);
    expect(bounds.hi).toEqual([430080, 368640, 238725]);
  });
});

describe("layerNmBounds", () => {
  it("uses the post-TM-317 global offset (offset × nm … (offset+size) × nm)", () => {
    const bounds = layerNmBounds(
      layerMeta({
        voxelSizeNm: [8, 8, 45],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [2048, 2048, 512],
      }),
    );
    expect(bounds.lo).toEqual([0, 0, 0]);
    expect(bounds.hi).toEqual([16384, 16384, 23040]);
  });

  it("honors a non-zero voxel offset", () => {
    const bounds = layerNmBounds(
      layerMeta({
        voxelSizeNm: [8, 8, 45],
        voxelOffset: [1000, 2000, 100],
        sizeVoxels: [500, 500, 100],
      }),
    );
    expect(bounds.lo).toEqual([8000, 16000, 4500]);
    expect(bounds.hi).toEqual([12000, 20000, 9000]);
  });
});

describe("classifyOverlap", () => {
  const layer = { lo: [0, 0, 0], hi: [100, 100, 100] } as const;

  it("returns 'contains' when the region is fully inside", () => {
    expect(classifyOverlap({ lo: [10, 10, 10], hi: [90, 90, 90] }, layer)).toBe(
      "contains",
    );
  });

  it("returns 'partial' when the region pokes outside on one axis", () => {
    expect(
      classifyOverlap({ lo: [10, 10, 10], hi: [90, 90, 150] }, layer),
    ).toBe("partial");
  });

  it("returns 'none' when disjoint on any axis", () => {
    expect(
      classifyOverlap({ lo: [200, 10, 10], hi: [300, 90, 90] }, layer),
    ).toBe("none");
  });

  it("treats edge-touching as disjoint (half-open bounds)", () => {
    // region.lo === layer.hi on x → no shared interior.
    expect(
      classifyOverlap({ lo: [100, 10, 10], hi: [150, 90, 90] }, layer),
    ).toBe("none");
  });
});

describe("checkLayerCompat", () => {
  it("flags the reported repro as 'none' (region far outside a small layer)", () => {
    // Annotation bbox at 80,80,45 nm vs. a 2048²×512 layer at 8,8,45 nm,
    // offset 0 — the region sits ≈369 µm out, the layer ends at ≈16 µm.
    const result = checkLayerCompat(
      [4608, 3840, 5304, 5376, 4608, 5305],
      regionSpaceNm(80, 80, 45),
      layerMeta({
        voxelSizeNm: [8, 8, 45],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [2048, 2048, 512],
      }),
    );
    expect(result.status).toBe("none");
    expect(result.regionNm.lo).toEqual([368640, 307200, 238680]);
    expect(result.layerNm.hi).toEqual([16384, 16384, 23040]);
  });

  it("flags an overlapping region as 'contains'", () => {
    // Region drawn at the layer's own 8 nm grid, well within its extent.
    const result = checkLayerCompat(
      [100, 100, 50, 200, 200, 60],
      regionSpaceNm(8, 8, 45),
      layerMeta({
        voxelSizeNm: [8, 8, 45],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [2048, 2048, 512],
      }),
    );
    expect(result.status).toBe("contains");
  });
});
