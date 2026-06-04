/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  BrushApplyInput,
  BrushStrokeInput,
  ChunkId as ChunkIdType,
  FillInput,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import { ChunkId, Resolution, layerId } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

const TARGET_RES = Resolution.from([8, 8, 40]);
const TARGET_LAYER = layerId("L1");

function metadata(
  chunkDataSize: readonly [number, number, number] = [64, 64, 64],
): LayerMetadata {
  return {
    layerId: TARGET_LAYER,
    voxelDataType: "uint64",
    channels: 1,
    scales: [
      {
        resolution: TARGET_RES,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [1024, 1024, 1024],
        chunkDataSize,
      },
    ],
  };
}

/** Zero-filled chunk reader for tests. */
function zeroReader(
  chunkDataSize: readonly [number, number, number],
): (chunkId: ChunkIdType) => Promise<ReadonlyChunkVoxelBuffer> {
  const volume =
    chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
  return async () => {
    const view = new BigUint64Array(volume);
    return { byteLength: view.byteLength, asView: () => view };
  };
}

/** readChunkAt stub for tests that don't exercise the mask path. */
const unusedReadChunkAt = async () => {
  throw new Error("readChunkAt unused in this test");
};

/** uint8 image-layer metadata for mask tests. */
const MASK_LAYER = layerId("M1");
function imageMetadata(
  chunkDataSize: readonly [number, number, number] = [16, 16, 16],
  voxelSizeNm: readonly [number, number, number] = [8, 8, 40],
): LayerMetadata {
  return {
    layerId: MASK_LAYER,
    voxelDataType: "uint8",
    channels: 1,
    scales: [
      {
        resolution: TARGET_RES,
        voxelSizeNm,
        voxelOffset: [0, 0, 0],
        sizeVoxels: [256, 256, 256],
        chunkDataSize,
      },
    ],
  };
}

/**
 * Image-chunk reader: returns uint8 chunks filled with `valueFn(ix, iy, iz)`
 * where coords are in global image-voxel space. Tracks call counts so tests
 * can assert caching.
 */
function imageReader(
  chunkDataSize: readonly [number, number, number],
  valueFn: (ix: number, iy: number, iz: number) => number,
): {
  readChunkAt: (
    _layer: unknown,
    _res: unknown,
    chunkId: ChunkIdType,
  ) => Promise<ReadonlyChunkVoxelBuffer>;
  calls: { count: number };
} {
  const volume = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
  const calls = { count: 0 };
  return {
    calls,
    readChunkAt: async (_layer, _res, chunkId) => {
      calls.count++;
      const c = ChunkId.toCoord(chunkId);
      const buf = new Uint8Array(volume);
      for (let lz = 0; lz < chunkDataSize[2]; lz++) {
        for (let ly = 0; ly < chunkDataSize[1]; ly++) {
          for (let lx = 0; lx < chunkDataSize[0]; lx++) {
            const ix = c.x * chunkDataSize[0] + lx;
            const iy = c.y * chunkDataSize[1] + ly;
            const iz = c.z * chunkDataSize[2] + lz;
            buf[lx + chunkDataSize[0] * (ly + chunkDataSize[1] * lz)] =
              valueFn(ix, iy, iz);
          }
        }
      }
      return { byteLength: buf.byteLength, asView: () => buf };
    },
  };
}

/**
 * Disk footprint helper — counts integer (dx, dy) pairs with
 * dx*dx + dy*dy <= r*r, matching `stampDisk2D` in painting_compute.ts.
 */
function diskFootprint(radius: number): number {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return 1;
  const r2 = r * r;
  let count = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) count++;
    }
  }
  return count;
}

describe("PaintingCompute.applyBrush", () => {
  it("radius 0 stamps a single voxel into one chunk", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const input: BrushApplyInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 0,
      value: 42n,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    };
    const batch = await compute.applyBrush(input);
    expect(batch.chunks).toHaveLength(1);
    expect(batch.targetLayerId).toBe(TARGET_LAYER);
    expect(batch.targetResolution).toBe(TARGET_RES);
    // Single voxel — subregion has 1x1x1.
    const c = batch.chunks[0];
    expect(c.subregion.size).toEqual([1, 1, 1]);
    expect(c.values.length).toBe(1);
    expect((c.values as BigUint64Array)[0]).toBe(42n);
    expect(c.valueMask![0]).toBe(1);
  });

  it("radius 3 stamps a disk of the expected footprint into a single chunk", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const radius = 3;
    const input: BrushApplyInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      // Center well inside one chunk so the disk does not cross a boundary.
      voxelPosition: [32, 32, 16],
      radius,
      value: 7n,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    };
    const batch = await compute.applyBrush(input);
    expect(batch.chunks).toHaveLength(1);
    const c = batch.chunks[0];
    const expectedFootprint = diskFootprint(radius);
    // Number of mask-set voxels in the dense block equals the footprint.
    let setBits = 0;
    for (const b of c.valueMask!) if (b !== 0) setBits++;
    expect(setBits).toBe(expectedFootprint);
  });

  it("a disk straddling a chunk boundary splits across two chunks", async () => {
    const compute = new PaintingCompute();
    // Use a small chunk size so disk crosses the boundary.
    const meta = metadata([8, 8, 8]);
    const input: BrushApplyInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      // x=7 is the last voxel of chunk (0,*,*); radius 2 reaches x=9 in chunk (1,*,*).
      voxelPosition: [7, 4, 4],
      radius: 2,
      value: 5n,
      readChunk: zeroReader([8, 8, 8]),
      readChunkAt: unusedReadChunkAt,
    };
    const batch = await compute.applyBrush(input);
    expect(batch.chunks.length).toBe(2);
    const totalSet = batch.chunks.reduce((acc, c) => {
      let s = 0;
      for (const b of c.valueMask!) if (b !== 0) s++;
      return acc + s;
    }, 0);
    expect(totalSet).toBe(diskFootprint(2));
  });
});

describe("PaintingCompute.applyBrushStroke", () => {
  it("a single endpoint stroke (short segment) stamps once", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const input: BrushStrokeInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      from: [10, 10, 0],
      to: [10, 10, 0], // zero-length: only the endpoint stamp fires
      radius: 0,
      value: 1n,
      stepVoxels: 1,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    };
    const batch = await compute.applyBrushStroke(input);
    expect(batch.chunks).toHaveLength(1);
    expect(batch.chunks[0].subregion.size).toEqual([1, 1, 1]);
  });

  it("a longer stroke writes contiguous voxels (no gaps) along the line", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    // Axis-aligned stroke from (10,32,16) to (30,32,16): 21 voxels inclusive
    // with radius 0 and step 1.
    const input: BrushStrokeInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      from: [10, 32, 16],
      to: [30, 32, 16],
      radius: 0,
      value: 9n,
      stepVoxels: 1,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    };
    const batch = await compute.applyBrushStroke(input);
    // Every chunk write fits in chunk (0,0,0).
    expect(batch.chunks).toHaveLength(1);
    const c = batch.chunks[0];
    const { origin, size } = c.subregion;
    // Bounding-box X extent must span the stroke (x = 11..30 since `from` is
    // excluded). For axis-aligned writes that means the dense block covers
    // every x in that range.
    const xs = new Set<number>();
    for (let z = 0; z < size[2]; z++) {
      for (let y = 0; y < size[1]; y++) {
        for (let x = 0; x < size[0]; x++) {
          const linear = x + size[0] * (y + size[1] * z);
          if ((c.valueMask as Uint8Array)[linear] !== 0) {
            xs.add(origin[0] + x);
          }
        }
      }
    }
    // Stroke from x=10 to x=30 with i starting at 1 covers x in [11, 30] (20 distinct voxels).
    const expected = [];
    for (let x = 11; x <= 30; x++) expected.push(x);
    expect(Array.from(xs).sort((a, b) => a - b)).toEqual(expected);
  });
});

describe("PaintingCompute.fill3d", () => {
  it("caps total voxels written at maxVoxels (truncated batch)", async () => {
    const compute = new PaintingCompute();
    // 64^3 chunk full of zero baseline; fill seed 0 -> 1 would mark every
    // voxel; cap of 50 forces early termination.
    const meta = metadata([64, 64, 64]);
    const input: FillInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      seedVoxelPosition: [32, 32, 32],
      value: 1n,
      maxVoxels: 50,
      readChunk: zeroReader([64, 64, 64]),
    };
    const batch = await compute.fill3d(input);
    expect(batch.truncated).toBeDefined();
    expect(batch.truncated!.reason).toBe("max-voxels");
    expect(batch.truncated!.voxelsWritten).toBe(50);
    const written = batch.chunks.reduce((acc, c) => {
      let s = 0;
      for (const b of c.valueMask!) if (b !== 0) s++;
      return acc + s;
    }, 0);
    expect(written).toBe(50);
  });

  it("short-circuits when seed value already equals target", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const input: FillInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      seedVoxelPosition: [32, 32, 32],
      value: 0n,
      maxVoxels: 1000,
      readChunk: zeroReader([64, 64, 64]),
    };
    const batch = await compute.fill3d(input);
    expect(batch.chunks).toHaveLength(0);
    expect(batch.truncated).toBeUndefined();
  });
});

describe("PaintingCompute.applyBrush with mask", () => {
  it("full-band mask paints every voxel (valueMask all 1s)", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const maskMeta = imageMetadata([64, 64, 64]);
    const image = imageReader([64, 64, 64], () => 128);
    const batch = await compute.applyBrush({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 3,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 0,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
      maskMetadata: maskMeta,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: image.readChunkAt,
    });
    expect(batch.chunks).toHaveLength(1);
    const c = batch.chunks[0];
    let setBits = 0;
    for (const b of c.valueMask!) if (b !== 0) setBits++;
    expect(setBits).toBe(diskFootprint(3));
  });

  it("low > all image values stamps the disk but valueMask is all 0", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const maskMeta = imageMetadata([64, 64, 64]);
    const image = imageReader([64, 64, 64], () => 50);
    const batch = await compute.applyBrush({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 3,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 200,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
      maskMetadata: maskMeta,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: image.readChunkAt,
    });
    expect(batch.chunks).toHaveLength(1);
    const c = batch.chunks[0];
    let setBits = 0;
    for (const b of c.valueMask!) if (b !== 0) setBits++;
    expect(setBits).toBe(0);
  });

  it("paints only voxels in the threshold band", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const maskMeta = imageMetadata([64, 64, 64]);
    // Image: left half (ix < 32) bright, right half dark.
    const image = imageReader([64, 64, 64], (ix) => (ix < 32 ? 200 : 50));
    const batch = await compute.applyBrush({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 4,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 150,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
      maskMetadata: maskMeta,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: image.readChunkAt,
    });
    expect(batch.chunks.length).toBeGreaterThan(0);
    let painted = 0;
    for (const c of batch.chunks) {
      const { origin, size } = c.subregion;
      for (let z = 0; z < size[2]; z++) {
        for (let y = 0; y < size[1]; y++) {
          for (let x = 0; x < size[0]; x++) {
            const linear = x + size[0] * (y + size[1] * z);
            if (c.valueMask![linear] !== 0) {
              const gx = origin[0] + x + c.chunkCoord.x * 64;
              expect(gx).toBeLessThan(32);
              painted++;
            }
          }
        }
      }
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("paints with image resolution coarser than target (2x ratio)", async () => {
    const compute = new PaintingCompute();
    // Target 8nm, image 16nm. Image bright region at ix < 16 corresponds
    // to target gx < 32.
    const meta = metadata([64, 64, 64]);
    const maskMeta = imageMetadata([32, 32, 32], [16, 16, 40]);
    const image = imageReader([32, 32, 32], (ix) => (ix < 16 ? 200 : 50));
    const batch = await compute.applyBrush({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 4,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 150,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
      maskMetadata: maskMeta,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: image.readChunkAt,
    });
    let painted = 0;
    for (const c of batch.chunks) {
      const { origin, size } = c.subregion;
      for (let z = 0; z < size[2]; z++) {
        for (let y = 0; y < size[1]; y++) {
          for (let x = 0; x < size[0]; x++) {
            if (c.valueMask![x + size[0] * (y + size[1] * z)] !== 0) {
              const gx = origin[0] + x + c.chunkCoord.x * 64;
              expect(gx).toBeLessThan(32);
              painted++;
            }
          }
        }
      }
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("falls back to unmasked stroke when maskMetadata is missing", async () => {
    const compute = new PaintingCompute();
    const meta = metadata([64, 64, 64]);
    const batch = await compute.applyBrush({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: meta,
      voxelPosition: [32, 32, 16],
      radius: 3,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 200,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
      // maskMetadata intentionally omitted.
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    });
    expect(batch.chunks).toHaveLength(1);
    let setBits = 0;
    for (const b of batch.chunks[0].valueMask!) if (b !== 0) setBits++;
    expect(setBits).toBe(diskFootprint(3));
  });
});
