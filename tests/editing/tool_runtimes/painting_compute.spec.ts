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
  ChunkId as ChunkIdType,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import { ChunkId, Resolution, layerId } from "@zettaai/edit-session";

import { describe, it, expect, vi } from "vitest";

import type { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type { MorphologyRequest } from "#src/editing/tool_runtimes/morphology_request.js";
import type {
  BrushApplyInput,
  BrushStrokeInput,
  FillInput,
  PaintChunkWrite,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

/**
 * Minimal stand-in for the pyodide `MorphologyClient` — only `apply` is used by
 * `PaintingCompute`. `apply` is a vitest mock so tests can assert the offload
 * request and control the processed mask (or force a failure to exercise the
 * TS fallback).
 */
function fakeMorphology(
  impl: (req: MorphologyRequest) => Promise<Uint8Array>,
): { client: MorphologyClient; apply: ReturnType<typeof vi.fn> } {
  const apply = vi.fn(impl);
  // `isReady: () => false` keeps these TM-304 tests on the morphology `apply`
  // offload path: the TM-317 whole-pipeline route is only taken when the worker
  // reports ready (covered separately in painting_compute_pyodide_pipeline.spec).
  return {
    client: { apply, isReady: () => false } as unknown as MorphologyClient,
    apply,
  };
}

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
  const volume = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
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
            buf[lx + chunkDataSize[0] * (ly + chunkDataSize[1] * lz)] = valueFn(
              ix,
              iy,
              iz,
            );
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

// -- Fill helpers -----------------------------------------------------------

type Bounds = {
  loX: number;
  loY: number;
  loZ: number;
  hiX: number;
  hiY: number;
  hiZ: number;
};

function bounds(
  loX: number,
  loY: number,
  loZ: number,
  hiX: number,
  hiY: number,
  hiZ: number,
): Bounds {
  return { loX, loY, loZ, hiX, hiY, hiZ };
}

/** Whole-volume bounds (matches the 1024³ metadata extent). */
function fullBounds(): Bounds {
  return bounds(0, 0, 0, 1024, 1024, 1024);
}

/**
 * uint64 chunk reader whose voxels are `valueFn(gx, gy, gz)` in GLOBAL voxel
 * coords — lets a test paint a baseline (e.g. a wall around an empty pocket).
 */
function patternReader(
  chunkDataSize: readonly [number, number, number],
  valueFn: (gx: number, gy: number, gz: number) => bigint,
): (chunkId: ChunkIdType) => Promise<ReadonlyChunkVoxelBuffer> {
  const [sx, sy, sz] = chunkDataSize;
  const volume = sx * sy * sz;
  return async (chunkId) => {
    const c = ChunkId.toCoord(chunkId);
    const view = new BigUint64Array(volume);
    for (let lz = 0; lz < sz; lz++) {
      for (let ly = 0; ly < sy; ly++) {
        for (let lx = 0; lx < sx; lx++) {
          view[lx + sx * (ly + sy * lz)] = valueFn(
            c.x * sx + lx,
            c.y * sy + ly,
            c.z * sz + lz,
          );
        }
      }
    }
    return { byteLength: view.byteLength, asView: () => view };
  };
}

/** Collect the GLOBAL coords of every mask-set voxel in a write batch. */
function writtenVoxels(
  batch: { chunks: readonly PaintChunkWrite[] },
  chunkDataSize: readonly [number, number, number],
): Array<[number, number, number]> {
  const [sx, sy, sz] = chunkDataSize;
  const out: Array<[number, number, number]> = [];
  for (const w of batch.chunks) {
    const [ox, oy, oz] = w.subregion.origin;
    const [wx, wy, wz] = w.subregion.size;
    const mask = w.valueMask;
    for (let z = 0; z < wz; z++) {
      for (let y = 0; y < wy; y++) {
        for (let x = 0; x < wx; x++) {
          if (mask !== undefined && mask[x + wx * (y + wy * z)] === 0) continue;
          out.push([
            w.chunkCoord.x * sx + ox + x,
            w.chunkCoord.y * sy + oy + y,
            w.chunkCoord.z * sz + oz + z,
          ]);
        }
      }
    }
  }
  return out;
}

describe("PaintingCompute.fill", () => {
  it("caps total voxels written at maxVoxels (truncated batch)", async () => {
    const compute = new PaintingCompute();
    // 64^3 chunk full of zero baseline; fill seed 0 -> 1 would mark every
    // voxel; cap of 50 forces early termination.
    const input: FillInput = {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [32, 32, 32],
      value: 1n,
      mode: "3d",
      bounds: fullBounds(),
      maxVoxels: 50,
      readChunk: zeroReader([64, 64, 64]),
    };
    const batch = await compute.fill(input);
    expect(batch.truncated).toBeDefined();
    expect(batch.truncated!.reason).toBe("max-voxels");
    expect(batch.truncated!.voxelsWritten).toBe(50);
    expect(writtenVoxels(batch, [64, 64, 64])).toHaveLength(50);
  });

  it("short-circuits when seed value already equals target", async () => {
    const compute = new PaintingCompute();
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [32, 32, 32],
      value: 0n,
      mode: "3d",
      bounds: fullBounds(),
      maxVoxels: 1000,
      readChunk: zeroReader([64, 64, 64]),
    });
    expect(batch.chunks).toHaveLength(0);
    expect(batch.truncated).toBeUndefined();
  });

  it("2D fill stays on the seed's Z slice", async () => {
    const compute = new PaintingCompute();
    // 10×10 in-plane region; Z bounds span the chunk but 2D must not leave z=32.
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [32, 32, 32],
      value: 1n,
      mode: "2d",
      bounds: bounds(28, 28, 0, 38, 38, 64),
      readChunk: zeroReader([64, 64, 64]),
    });
    const voxels = writtenVoxels(batch, [64, 64, 64]);
    expect(voxels).toHaveLength(100); // the full 10×10 bounded slice
    expect(voxels.every(([, , z]) => z === 32)).toBe(true);
    expect(batch.truncated).toBeUndefined();
  });

  it("3D fill propagates across Z slices", async () => {
    const compute = new PaintingCompute();
    // 4×4×4 bounded box; 3D fills all of it, spanning multiple sections.
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [32, 32, 32],
      value: 1n,
      mode: "3d",
      bounds: bounds(30, 30, 30, 34, 34, 34),
      readChunk: zeroReader([64, 64, 64]),
    });
    const voxels = writtenVoxels(batch, [64, 64, 64]);
    expect(voxels).toHaveLength(64); // 4×4×4
    expect(voxels.some(([, , z]) => z !== 32)).toBe(true);
  });

  it("2D fill of an enclosed empty pocket stays inside the wall", async () => {
    const compute = new PaintingCompute();
    // A square ring of segment id 9 on z=32 around an empty 9×9 interior; the
    // same value also rings nothing outside, which stays empty. Seeding the
    // interior must fill only the interior — not the wall, not the outside.
    const onWall = (x: number, y: number) =>
      (x === 30 || x === 40) && y >= 30 && y <= 40
        ? true
        : (y === 30 || y === 40) && x >= 30 && x <= 40;
    const reader = patternReader([64, 64, 64], (gx, gy, gz) =>
      gz === 32 && onWall(gx, gy) ? 9n : 0n,
    );
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [35, 35, 32],
      value: 1n,
      mode: "2d",
      bounds: fullBounds(),
      readChunk: reader,
    });
    const voxels = writtenVoxels(batch, [64, 64, 64]);
    expect(voxels).toHaveLength(81); // interior 9×9
    // Every written voxel is strictly inside the wall (31..39) on z=32.
    expect(
      voxels.every(
        ([x, y, z]) => z === 32 && x >= 31 && x <= 39 && y >= 31 && y <= 39,
      ),
    ).toBe(true);
    // The wall itself is never overwritten.
    expect(voxels.some(([x, y]) => onWall(x, y))).toBe(false);
  });

  it("2D fill of an open region terminates at the bounds (no runaway)", async () => {
    const compute = new PaintingCompute();
    // All-empty slice with no walls: only the bounds stop the flood. Without a
    // bound this is the old diamond/cap runaway; here it fills the 8×8 box.
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [33, 33, 32],
      value: 1n,
      mode: "2d",
      bounds: bounds(30, 30, 0, 38, 38, 64),
      maxVoxels: 1 << 20,
      readChunk: zeroReader([64, 64, 64]),
    });
    expect(writtenVoxels(batch, [64, 64, 64])).toHaveLength(64); // 8×8
    expect(batch.truncated).toBeUndefined(); // bounded, not cap-truncated
  });

  it("fills a large region entirely (no default-cap truncation)", async () => {
    const compute = new PaintingCompute();
    // A bounded slice well past the old 1<<20 (~1.05M) default cap — the bug a
    // user hit: the fill stopped at a ~1M-voxel blob instead of covering the
    // whole edit region. The region bound now terminates the flood, so the
    // entire slice fills and nothing is reported truncated. Thin Z chunks keep
    // the test's per-chunk allocations small.
    const chunk: readonly [number, number, number] = [64, 64, 1];
    const W = 1100;
    const H = 1000; // 1.1M voxels > old 1<<20 default cap
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata(chunk),
      seedVoxelPosition: [W / 2, H / 2, 0],
      value: 1n,
      mode: "2d",
      bounds: bounds(0, 0, 0, W, H, 1),
      readChunk: zeroReader(chunk),
    });
    expect(batch.truncated).toBeUndefined();
    expect(writtenVoxels(batch, chunk)).toHaveLength(W * H);
  });

  it("stops on memory pressure and reports out-of-memory (keeps partial)", async () => {
    const compute = new PaintingCompute();
    // A tiny memory budget trips the portable backstop (Node has no
    // `performance.memory`) after the first chunk's visited bitmap is allocated.
    // The fill stops gracefully, reports out-of-memory, and keeps what it
    // painted so far (not discarded).
    const batch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [200, 200, 0],
      value: 1n,
      mode: "2d",
      bounds: bounds(0, 0, 0, 4096, 4096, 1),
      readChunk: zeroReader([64, 64, 64]),
      flushIntervalMs: 0, // check the budget on essentially every step
      memoryBudgetBytes: 1, // any allocation trips it
    });
    expect(batch.truncated).toBeDefined();
    expect(batch.truncated!.reason).toBe("out-of-memory");
    // Partial work is kept (some voxels were painted before the stop).
    expect(batch.truncated!.voxelsWritten).toBeGreaterThan(0);
    expect(writtenVoxels(batch, [64, 64, 64]).length).toBeGreaterThan(0);
  });

  it("flushes progressively and reports progress", async () => {
    const compute = new PaintingCompute();
    const flushes: Array<{ chunks: readonly PaintChunkWrite[] }> = [];
    const progress: number[] = [];
    // flushIntervalMs:0 forces a flush after essentially every step.
    const finalBatch = await compute.fill({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      seedVoxelPosition: [31, 31, 32],
      value: 1n,
      mode: "2d",
      bounds: bounds(30, 30, 0, 33, 33, 64), // 3×3 = 9 voxels
      readChunk: zeroReader([64, 64, 64]),
      flushIntervalMs: 0,
      onFlush: async (b) => {
        flushes.push({ chunks: b.chunks });
      },
      onProgress: (p) => progress.push(p.voxelsWritten),
    });
    // Progressive: at least one intermediate flush happened.
    expect(flushes.length).toBeGreaterThan(0);
    // The flushes plus the returned remainder cover exactly the 9 voxels once.
    const all = [
      ...flushes.flatMap((b) => writtenVoxels(b, [64, 64, 64])),
      ...writtenVoxels(finalBatch, [64, 64, 64]),
    ];
    const distinct = new Set(all.map(([x, y, z]) => `${x},${y},${z}`));
    expect(all).toHaveLength(9);
    expect(distinct.size).toBe(9);
    // Progress is monotonic and ends at the full count.
    expect(progress[progress.length - 1]).toBe(9);
  });

  it("rejects when the abort signal fires", async () => {
    const compute = new PaintingCompute();
    const controller = new AbortController();
    controller.abort();
    await expect(
      compute.fill({
        targetLayerId: TARGET_LAYER,
        targetResolution: TARGET_RES,
        metadata: metadata([64, 64, 64]),
        seedVoxelPosition: [32, 32, 32],
        value: 1n,
        mode: "2d",
        bounds: bounds(28, 28, 0, 38, 38, 64),
        readChunk: zeroReader([64, 64, 64]),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
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

  it("low > all image values paints nothing (no painted voxels)", async () => {
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
    // Slice-mode write skips masked-off voxels, so a fully-rejected stamp emits
    // no chunks at all (equivalent to a chunk whose valueMask is all zero).
    let setBits = 0;
    for (const c of batch.chunks) {
      for (const b of c.valueMask!) if (b !== 0) setBits++;
    }
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

describe("PaintingCompute morphology offload (TM-304)", () => {
  function maskedBrushInput(radius: number) {
    return {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      voxelPosition: [32, 32, 16] as [number, number, number],
      radius,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 0,
        thresholdHigh: 255,
        minComponentSize: 5,
        binaryClosing: 2,
        filterComponentsFirst: true,
      },
      maskMetadata: imageMetadata([64, 64, 64]),
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: imageReader([64, 64, 64], () => 128).readChunkAt,
    };
  }

  it("offloads morphology to the client with the disk-bbox request", async () => {
    const radius = 3;
    const side = 2 * radius + 1;
    // Echo the input mask back so the stamp reflects the worker's output.
    const { client, apply } = fakeMorphology(async (req) => req.mask);
    const compute = new PaintingCompute(client);

    await compute.applyBrush(maskedBrushInput(radius));

    expect(apply).toHaveBeenCalledTimes(1);
    const req = apply.mock.calls[0][0] as MorphologyRequest;
    expect(req.shape).toEqual([side, side, 1]);
    expect(req.mask).toHaveLength(side * side);
    // Params forwarded verbatim from the mask context.
    expect(req.binaryClosing).toBe(2);
    expect(req.minComponentSize).toBe(5);
    expect(req.filterComponentsFirst).toBe(true);
  });

  it("uses the worker's processed mask to drive the stamp", async () => {
    // Worker returns an all-zero mask → nothing should be painted, even though
    // the threshold band (0..255) would otherwise pass every voxel.
    const { client } = fakeMorphology(
      async (req) => new Uint8Array(req.mask.length),
    );
    const compute = new PaintingCompute(client);

    const batch = await compute.applyBrush(maskedBrushInput(3));
    let setBits = 0;
    for (const b of batch.chunks[0]?.valueMask ?? []) if (b !== 0) setBits++;
    expect(setBits).toBe(0);
  });

  it("falls back to the TS pipeline when the worker rejects", async () => {
    const { client, apply } = fakeMorphology(async () => {
      throw new Error("worker boot failed");
    });
    const withWorker = new PaintingCompute(client);
    const withoutWorker = new PaintingCompute(); // pure TS path

    // Morphology IS requested (binaryClosing > 0) so the worker is invoked and
    // can fail — closing of a full-band solid disk is identity, so both the
    // fallback and the pure-TS compute still paint the full disk footprint.
    const input = {
      ...maskedBrushInput(3),
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 0,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 1,
        filterComponentsFirst: false,
      },
    };
    const fallbackBatch = await withWorker.applyBrush(input);
    const tsBatch = await withoutWorker.applyBrush(input);

    expect(apply).toHaveBeenCalled(); // worker was attempted...
    // ...and the fallback produced the same result as the pure-TS compute
    // (closing shrinks the bbox-edge voxels, so this is < the raw disk).
    const count = (b: typeof fallbackBatch) => {
      let n = 0;
      for (const v of b.chunks[0]?.valueMask ?? []) if (v !== 0) n++;
      return n;
    };
    expect(count(fallbackBatch)).toBeGreaterThan(0);
    expect(count(fallbackBatch)).toBe(count(tsBatch));
  });
});

describe("PaintingCompute capsule stroke (TM-304)", () => {
  // A masked stroke input on a single z-slice with morphology requested.
  function maskedStrokeInput(
    from: [number, number, number],
    to: [number, number, number],
    radius: number,
    morphology = true,
  ) {
    return {
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      from,
      to,
      stepVoxels: 1,
      radius,
      value: 7n,
      mask: {
        imageLayerId: MASK_LAYER,
        imageResolution: TARGET_RES,
        thresholdLow: 0,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: morphology ? 1 : 0,
        filterComponentsFirst: false,
      },
      maskMetadata: imageMetadata([64, 64, 64]),
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: imageReader([64, 64, 64], () => 128).readChunkAt,
    };
  }

  it("runs morphology ONCE for a whole same-z segment (per-segment union)", async () => {
    // A 24-voxel segment with radius 6: the old per-dab path (spacing radius/2)
    // would call morphology ~ceil(24/3)=8 times; the capsule calls it once.
    const { client, apply } = fakeMorphology(async (req) => req.mask);
    const compute = new PaintingCompute(client);

    await compute.applyBrushStroke(
      maskedStrokeInput([20, 32, 16], [44, 32, 16], 6),
    );

    expect(apply).toHaveBeenCalledTimes(1);
    // The single request's footprint spans the whole segment bbox + radius.
    const req = apply.mock.calls[0][0] as MorphologyRequest;
    expect(req.shape[0]).toBeGreaterThanOrEqual(24 + 2 * 6); // x: |to-from| + 2r
    expect(req.shape[2]).toBe(1); // single z-slice
  });

  it("falls back to per-dab (morphology per dab) for a z-varying segment", async () => {
    const { apply, client } = fakeMorphology(async (req) => req.mask);
    const compute = new PaintingCompute(client);

    // from/to on different z-slices → 3D sweep → per-dab fallback.
    await compute.applyBrushStroke(
      maskedStrokeInput([20, 32, 10], [20, 32, 34], 6),
    );

    expect(apply.mock.calls.length).toBeGreaterThan(1);
  });

  it("unmasked stroke paints a gap-free capsule covering both endpoints", async () => {
    const compute = new PaintingCompute(); // no mask
    const batch = await compute.applyBrushStroke({
      targetLayerId: TARGET_LAYER,
      targetResolution: TARGET_RES,
      metadata: metadata([64, 64, 64]),
      from: [16, 32, 16],
      to: [40, 32, 16],
      stepVoxels: 1,
      radius: 4,
      value: 7n,
      readChunk: zeroReader([64, 64, 64]),
      readChunkAt: unusedReadChunkAt,
    });

    // Collect painted (x) along the centerline row y=32, z=16 within the chunk.
    const c = batch.chunks[0];
    const [ox, oy, oz] = c.subregion.origin;
    const [sx, sy] = c.subregion.size;
    const painted = new Set<number>();
    for (let i = 0; i < c.valueMask!.length; i++) {
      if (c.valueMask![i] === 0) continue;
      const rz = Math.floor(i / (sx * sy));
      const ry = Math.floor((i - rz * sx * sy) / sx);
      const rx = i - rz * sx * sy - ry * sx;
      if (oy + ry === 32 && oz + rz === 16) painted.add(ox + rx);
    }
    // The centerline must be solid from x=16 to x=40 (no gaps).
    for (let x = 16; x <= 40; x++) {
      expect(painted.has(x)).toBe(true);
    }
  });
});
