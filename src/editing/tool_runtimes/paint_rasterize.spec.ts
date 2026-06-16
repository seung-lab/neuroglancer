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
  stampMaskIntoChunk,
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

describe("stampMaskIntoChunk — masked footprint stamp", () => {
  // Footprint box [loTx, loTx+maskW) × [loTy, loTy+maskH) at z=cz; mask 1=paint.
  // The reference set is exactly {value @ mask=1}, intersected with each chunk.
  function maskVoxelSet(
    mask: Uint8Array,
    maskW: number,
    maskH: number,
    loTx: number,
    loTy: number,
    cz: number,
    chunkOrigins: readonly Vec3[],
  ): Set<string> {
    const out = new Set<string>();
    for (const origin of chunkOrigins) {
      const view = new Uint32Array(CHUNK * CHUNK * CHUNK);
      const sub = stampMaskIntoChunk(view, {
        mask,
        maskW,
        maskH,
        loTx,
        loTy,
        cz,
        value: PAINT_VALUE,
        chunkOrigin: origin,
        chunkSize: [CHUNK, CHUNK, CHUNK],
      });
      if (sub === undefined) continue;
      // Every written voxel must lie within the reported sub-box.
      for (let i = 0; i < view.length; i++) {
        if (view[i] !== PAINT_VALUE) continue;
        const x = i % CHUNK;
        const y = Math.floor(i / CHUNK) % CHUNK;
        const z = Math.floor(i / (CHUNK * CHUNK));
        expect(x).toBeGreaterThanOrEqual(sub.origin[0]);
        expect(x).toBeLessThanOrEqual(sub.origin[0] + sub.size[0] - 1);
        expect(y).toBeGreaterThanOrEqual(sub.origin[1]);
        expect(y).toBeLessThanOrEqual(sub.origin[1] + sub.size[1] - 1);
        expect(z).toBe(sub.origin[2]);
        out.add(`${origin[0] + x},${origin[1] + y},${origin[2] + z}`);
      }
    }
    return out;
  }

  /** Reference: the set the main-thread sample-back loop would paint. */
  function referenceSet(
    mask: Uint8Array,
    maskW: number,
    maskH: number,
    loTx: number,
    loTy: number,
    cz: number,
  ): Set<string> {
    const out = new Set<string>();
    for (let j = 0; j < maskH; j++) {
      for (let i = 0; i < maskW; i++) {
        if (mask[j * maskW + i] === 1) {
          out.add(`${loTx + i},${loTy + j},${cz}`);
        }
      }
    }
    return out;
  }

  it("stamps exactly {value @ mask=1} within a single chunk", () => {
    const maskW = 5;
    const maskH = 4;
    const mask = new Uint8Array(maskW * maskH);
    // A small diagonal + a stray voxel.
    mask[0 * maskW + 0] = 1;
    mask[1 * maskW + 1] = 1;
    mask[2 * maskW + 2] = 1;
    mask[3 * maskW + 4] = 1;
    const expected = referenceSet(mask, maskW, maskH, 10, 20, 30);
    const actual = maskVoxelSet(mask, maskW, maskH, 10, 20, 30, [[0, 0, 0]]);
    expectSameSet(actual, expected);
  });

  it("splits a footprint across a chunk boundary, union = whole footprint", () => {
    // Footprint straddles x=64. maskW spans [60, 70).
    const maskW = 10;
    const maskH = 3;
    const mask = new Uint8Array(maskW * maskH).fill(1);
    const loTx = 60;
    const loTy = 20;
    const cz = 5;
    const expected = referenceSet(mask, maskW, maskH, loTx, loTy, cz);
    const actual = maskVoxelSet(mask, maskW, maskH, loTx, loTy, cz, [
      [0, 0, 0],
      [64, 0, 0],
    ]);
    expect(actual.size).toBe(maskW * maskH);
    expectSameSet(actual, expected);
  });

  it("returns undefined when the z-slice or footprint misses the chunk", () => {
    const mask = new Uint8Array(4).fill(1);
    // z outside chunk:
    expect(
      stampMaskIntoChunk(new Uint32Array(CHUNK * CHUNK * CHUNK), {
        mask,
        maskW: 2,
        maskH: 2,
        loTx: 10,
        loTy: 10,
        cz: 200,
        value: PAINT_VALUE,
        chunkOrigin: [0, 0, 0],
        chunkSize: [CHUNK, CHUNK, CHUNK],
      }),
    ).toBeUndefined();
    // footprint outside chunk in x/y:
    expect(
      stampMaskIntoChunk(new Uint32Array(CHUNK * CHUNK * CHUNK), {
        mask,
        maskW: 2,
        maskH: 2,
        loTx: 200,
        loTy: 200,
        cz: 10,
        value: PAINT_VALUE,
        chunkOrigin: [0, 0, 0],
        chunkSize: [CHUNK, CHUNK, CHUNK],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the masked overlap is all-zero", () => {
    const mask = new Uint8Array(9); // all zero
    expect(
      stampMaskIntoChunk(new Uint32Array(CHUNK * CHUNK * CHUNK), {
        mask,
        maskW: 3,
        maskH: 3,
        loTx: 10,
        loTy: 10,
        cz: 10,
        value: PAINT_VALUE,
        chunkOrigin: [0, 0, 0],
        chunkSize: [CHUNK, CHUNK, CHUNK],
      }),
    ).toBeUndefined();
  });

  it("writes bigint values into a 64-bit view", () => {
    const view = new BigUint64Array(CHUNK * CHUNK * CHUNK);
    const mask = new Uint8Array(1).fill(1);
    const sub = stampMaskIntoChunk(view, {
      mask,
      maskW: 1,
      maskH: 1,
      loTx: 10,
      loTy: 12,
      cz: 3,
      value: 12345678901234567890n,
      chunkOrigin: [0, 0, 0],
      chunkSize: [CHUNK, CHUNK, CHUNK],
    });
    expect(sub).toBeDefined();
    const idx = (3 * CHUNK + 12) * CHUNK + 10;
    expect(view[idx]).toBe(12345678901234567890n);
  });

  it("bails (returns undefined) when shouldCancel fires", () => {
    const mask = new Uint8Array(64).fill(1);
    const sub = stampMaskIntoChunk(
      new Uint32Array(CHUNK * CHUNK * CHUNK),
      {
        mask,
        maskW: 8,
        maskH: 8,
        loTx: 10,
        loTy: 10,
        cz: 0,
        value: PAINT_VALUE,
        chunkOrigin: [0, 0, 0],
        chunkSize: [CHUNK, CHUNK, CHUNK],
      },
      () => true,
    );
    expect(sub).toBeUndefined();
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
