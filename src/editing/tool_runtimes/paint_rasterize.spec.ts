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
  ChunkId,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { Resolution as ResolutionCtor, layerId } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import {
  rasterizeStrokeIntoChunk,
  type Vec3,
} from "#src/editing/tool_runtimes/paint_rasterize.js";
import type { PaintWriteBatch } from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

const RES: Resolution = ResolutionCtor.from([8, 8, 8]);
const TARGET: LayerId = layerId("target");
const CHUNK = 64;
const PAINT_VALUE = 7;

// A 2x2x2 chunk grid so strokes can cross chunk boundaries.
function metadata(
  sizeVoxels: readonly [number, number, number],
): LayerMetadata {
  return {
    layerId: TARGET,
    voxelDataType: "uint32",
    channels: 1,
    scales: [
      {
        resolution: RES,
        voxelSizeNm: [8, 8, 8],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [...sizeVoxels],
        chunkDataSize: [CHUNK, CHUNK, CHUNK],
      },
    ],
  };
}

function zeroChunk(): ReadonlyChunkVoxelBuffer {
  const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
  return { byteLength: data.byteLength, asView: () => data };
}

/** Absolute coords of every voxel a PaintingCompute batch paints. */
function batchVoxelSet(batch: PaintWriteBatch): Set<string> {
  const out = new Set<string>();
  for (const chunk of batch.chunks) {
    const [ox, oy, oz] = chunk.subregion.origin;
    const [w, h] = chunk.subregion.size;
    const baseX = chunk.chunkCoord.x * CHUNK + ox;
    const baseY = chunk.chunkCoord.y * CHUNK + oy;
    const baseZ = chunk.chunkCoord.z * CHUNK + oz;
    const mask = chunk.valueMask;
    for (let i = 0; i < chunk.values.length; i++) {
      if (mask !== undefined && mask[i] === 0) continue;
      const x = baseX + (i % w);
      const y = baseY + (Math.floor(i / w) % h);
      const z = baseZ + Math.floor(i / (w * h));
      out.add(`${x},${y},${z}`);
    }
  }
  return out;
}

/** Run PaintingCompute for an unmasked stroke and return its painted voxel set. */
async function computeVoxelSet(
  points: readonly Vec3[],
  radius: number,
  sizeVoxels: readonly [number, number, number] = [CHUNK, CHUNK, CHUNK],
): Promise<Set<string>> {
  const compute = new PaintingCompute();
  const from = points[0];
  const to = points[points.length - 1];
  const via = points.slice(1, -1);
  const batch = await compute.applyBrushStroke({
    targetLayerId: TARGET,
    targetResolution: RES,
    metadata: metadata(sizeVoxels),
    from,
    to,
    ...(via.length > 0 ? { via } : {}),
    stepVoxels: 1,
    radius,
    value: PAINT_VALUE,
    readChunk: async () => zeroChunk(),
    readChunkAt: async (_l: LayerId, _r: Resolution, _c: ChunkId) =>
      zeroChunk(),
  });
  return batchVoxelSet(batch);
}

/** Rasterize the stroke into each given chunk and return the global covered set. */
function kernelVoxelSet(
  points: readonly Vec3[],
  radius: number,
  chunkOrigins: readonly Vec3[],
): Set<string> {
  const out = new Set<string>();
  for (const origin of chunkOrigins) {
    const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(view, {
      points,
      radius,
      value: PAINT_VALUE,
      chunkOrigin: origin,
      chunkSize: [CHUNK, CHUNK, CHUNK],
    });
    if (sub === undefined) continue;
    for (let i = 0; i < view.length; i++) {
      if (view[i] !== PAINT_VALUE) continue;
      const x = i % CHUNK;
      const y = Math.floor(i / CHUNK) % CHUNK;
      const z = Math.floor(i / (CHUNK * CHUNK));
      out.add(`${origin[0] + x},${origin[1] + y},${origin[2] + z}`);
    }
  }
  return out;
}

function expectSameSet(a: Set<string>, b: Set<string>): void {
  expect(a.size).toBe(b.size);
  for (const v of a) expect(b.has(v)).toBe(true);
}

describe("rasterizeStrokeIntoChunk — parity with PaintingCompute", () => {
  it("matches a single-chunk capsule (2 points)", async () => {
    const pts: Vec3[] = [
      [20, 20, 32],
      [40, 30, 32],
    ];
    const expected = await computeVoxelSet(pts, 4);
    const actual = kernelVoxelSet(pts, 4, [[0, 0, 0]]);
    expect(actual.size).toBeGreaterThan(0);
    expectSameSet(actual, expected);
  });

  it("matches a single-chunk polyline (L-shape, corner kept)", async () => {
    const pts: Vec3[] = [
      [20, 20, 32],
      [40, 20, 32],
      [40, 40, 32],
    ];
    const expected = await computeVoxelSet(pts, 4);
    const actual = kernelVoxelSet(pts, 4, [[0, 0, 0]]);
    expectSameSet(actual, expected);
  });

  it("matches a stroke spanning two chunks (tiles union to the whole footprint)", async () => {
    // Crosses the x = 64 chunk boundary.
    const pts: Vec3[] = [
      [50, 30, 32],
      [80, 30, 32],
    ];
    const expected = await computeVoxelSet(pts, 5, [128, 128, 128]);
    const actual = kernelVoxelSet(pts, 5, [
      [0, 0, 0],
      [64, 0, 0],
    ]);
    expect(actual.size).toBeGreaterThan(0);
    expectSameSet(actual, expected);
  });
});

describe("rasterizeStrokeIntoChunk — clipping and bounds", () => {
  it("returns undefined and leaves the view untouched when the stroke misses the chunk", () => {
    const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(view, {
      points: [
        [200, 200, 32],
        [210, 200, 32],
      ],
      radius: 4,
      value: PAINT_VALUE,
      chunkOrigin: [0, 0, 0],
      chunkSize: [CHUNK, CHUNK, CHUNK],
    });
    expect(sub).toBeUndefined();
    expect(view.some((v) => v !== 0)).toBe(false);
  });

  it("returns undefined when the z-slice is outside the chunk", () => {
    const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(view, {
      points: [
        [20, 20, 100],
        [30, 20, 100],
      ],
      radius: 4,
      value: PAINT_VALUE,
      chunkOrigin: [0, 0, 0],
      chunkSize: [CHUNK, CHUNK, CHUNK],
    });
    expect(sub).toBeUndefined();
  });

  it("returns a subregion that tightly bounds the written voxels", () => {
    const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(view, {
      points: [
        [30, 30, 10],
        [30, 30, 10],
      ],
      radius: 3,
      value: PAINT_VALUE,
      chunkOrigin: [0, 0, 0],
      chunkSize: [CHUNK, CHUNK, CHUNK],
    })!;
    expect(sub).toBeDefined();
    const [ox, oy, oz] = sub.origin;
    const [w, h, d] = sub.size;
    expect(oz).toBe(10);
    expect(d).toBe(1);
    // Every painted voxel lies inside the reported bbox; the bbox edges are touched.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < view.length; i++) {
      if (view[i] !== PAINT_VALUE) continue;
      const x = i % CHUNK;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    expect(minX).toBe(ox);
    expect(maxX).toBe(ox + w - 1);
    void oy;
    void h;
  });
});

describe("rasterizeStrokeIntoChunk — value types and cancellation", () => {
  it("writes bigint values into a 64-bit view", () => {
    const view = new BigUint64Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(view, {
      points: [[10, 10, 0]],
      radius: 2,
      value: 12345678901234567890n,
      chunkOrigin: [0, 0, 0],
      chunkSize: [CHUNK, CHUNK, CHUNK],
    });
    expect(sub).toBeDefined();
    const idx = (0 * CHUNK + 10) * CHUNK + 10; // center voxel
    expect(view[idx]).toBe(12345678901234567890n);
  });

  it("bails (returns undefined) when shouldCancel fires", () => {
    const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
    const sub = rasterizeStrokeIntoChunk(
      view,
      {
        points: [
          [10, 10, 0],
          [50, 50, 0],
        ],
        radius: 4,
        value: PAINT_VALUE,
        chunkOrigin: [0, 0, 0],
        chunkSize: [CHUNK, CHUNK, CHUNK],
      },
      () => true, // cancel immediately
    );
    expect(sub).toBeUndefined();
  });
});
