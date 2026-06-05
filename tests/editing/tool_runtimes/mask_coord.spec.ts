/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ScaleMetadata } from "@zettaai/edit-session";
import { Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import {
  targetToImageVoxel,
  imageChunksCovering,
  voxelDataTypeRange,
} from "#src/editing/tool_runtimes/mask_coord.js";

const SAME = [8, 8, 40] as const;
const COARSER = [16, 16, 40] as const;
const FINER = [4, 4, 40] as const;

describe("targetToImageVoxel", () => {
  it("is identity when sizes match", () => {
    expect(targetToImageVoxel([10, 20, 5], SAME, SAME)).toEqual([10, 20, 5]);
  });

  it("scales down when image is coarser (target nm < image nm)", () => {
    // target=8nm, image=16nm: target voxel (10, 20, 5) → physical
    // (80nm, 160nm, 200nm) → image voxel (5, 10, 5).
    expect(targetToImageVoxel([10, 20, 5], SAME, COARSER)).toEqual([5, 10, 5]);
  });

  it("scales up when image is finer (target nm > image nm)", () => {
    // target=8nm, image=4nm: target voxel (10, 20, 5) → physical
    // (80nm, 160nm, 200nm) → image voxel (20, 40, 5).
    expect(targetToImageVoxel([10, 20, 5], SAME, FINER)).toEqual([20, 40, 5]);
  });

  it("floors fractional image-voxel results", () => {
    // target=8nm, image=16nm: target voxel (1,3,5) → image (0,1,2)
    // (8/16=0.5→0, 24/16=1.5→1, 200/40=5 — same in Z).
    expect(targetToImageVoxel([1, 3, 5], SAME, COARSER)).toEqual([0, 1, 5]);
  });

  it("handles z-axis ratios independent of x/y", () => {
    // Anisotropic upscale only in Z.
    expect(targetToImageVoxel([4, 4, 10], [8, 8, 40], [8, 8, 20])).toEqual([
      4, 4, 20,
    ]);
  });
});

function scale(
  chunkDataSize: readonly [number, number, number],
): ScaleMetadata {
  return {
    resolution: Resolution.from([8, 8, 40]),
    voxelSizeNm: [8, 8, 40],
    voxelOffset: [0, 0, 0],
    sizeVoxels: [10000, 10000, 10000],
    chunkDataSize,
  };
}

describe("imageChunksCovering", () => {
  it("single chunk when the region is fully inside one chunk", () => {
    // chunk=64; voxels [10, 20) all live in chunk (0,0,0).
    const out = imageChunksCovering(
      [10, 10, 10],
      [20, 20, 20],
      scale([64, 64, 64]),
    );
    expect(out).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("two chunks when region straddles a boundary on one axis", () => {
    // chunk=64 in x; voxels x in [60, 70) crosses x-boundary at 64.
    const out = imageChunksCovering(
      [60, 0, 0],
      [70, 8, 8],
      scale([64, 64, 64]),
    );
    expect(out).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
  });

  it("eight chunks when region straddles all three boundaries", () => {
    const out = imageChunksCovering(
      [60, 60, 60],
      [70, 70, 70],
      scale([64, 64, 64]),
    );
    expect(out).toHaveLength(8);
    // First and last:
    expect(out[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(out[out.length - 1]).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("empty region returns no chunks", () => {
    expect(
      imageChunksCovering([5, 5, 5], [5, 5, 5], scale([64, 64, 64])),
    ).toEqual([]);
    expect(
      imageChunksCovering([10, 0, 0], [5, 8, 8], scale([64, 64, 64])),
    ).toEqual([]);
  });

  it("respects non-cubic chunk shapes", () => {
    // chunk=32x32x16: voxel (33, 0, 17) lives in chunk (1, 0, 1).
    const out = imageChunksCovering(
      [33, 0, 17],
      [34, 1, 18],
      scale([32, 32, 16]),
    );
    expect(out).toEqual([{ x: 1, y: 0, z: 1 }]);
  });
});

describe("voxelDataTypeRange", () => {
  it.each([
    ["uint8", { min: 0, max: 255 }],
    ["int8", { min: -128, max: 127 }],
    ["uint16", { min: 0, max: 65535 }],
    ["int16", { min: -32768, max: 32767 }],
    ["uint32", { min: 0, max: 4294967295 }],
    ["int32", { min: -2147483648, max: 2147483647 }],
  ] as const)("returns the right range for %s", (type, expected) => {
    expect(voxelDataTypeRange(type)).toEqual(expected);
  });

  it("float32 spans the full numeric range", () => {
    const r = voxelDataTypeRange("float32");
    expect(r).not.toBeNull();
    expect(r!.min).toBeLessThan(0);
    expect(r!.max).toBeGreaterThan(0);
  });

  it("uint64 is unsupported (returns null)", () => {
    expect(voxelDataTypeRange("uint64")).toBeNull();
  });
});
