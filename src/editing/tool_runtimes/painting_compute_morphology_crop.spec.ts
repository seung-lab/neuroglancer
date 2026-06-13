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

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import type { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type { MorphologyRequest } from "#src/editing/tool_runtimes/morphology_request.js";
import type {
  BrushApplyInput,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RES: Resolution = ResolutionCtor.from([8, 8, 40]);
const TARGET_LAYER: LayerId = layerId("target");
const IMAGE_LAYER: LayerId = layerId("image");

const CHUNK = 64;
const Z = 32;
const IN_BAND = 100; // inside the [90, 150] threshold band
const BAND_LOW = 90;
const BAND_HIGH = 150;

function singleScaleMetadata(
  id: LayerId,
  voxelDataType: LayerMetadata["voxelDataType"],
): LayerMetadata {
  return {
    layerId: id,
    voxelDataType,
    channels: 1,
    scales: [
      {
        resolution: RES,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [CHUNK, CHUNK, CHUNK],
        chunkDataSize: [CHUNK, CHUNK, CHUNK],
      },
    ],
  };
}

/** Image chunk with `IN_BAND` at the given absolute (x, y) pixels on slice Z. */
function imageChunkWith(
  pixels: readonly (readonly [number, number])[],
): ReadonlyChunkVoxelBuffer {
  const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
  for (const [x, y] of pixels) {
    data[x + CHUNK * (y + CHUNK * Z)] = IN_BAND;
  }
  return { byteLength: data.byteLength, asView: () => data };
}

function brushInput(
  image: ReadonlyChunkVoxelBuffer,
  opts: { radius: number; binaryClosing: number; minComponentSize: number },
): BrushApplyInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: RES,
    metadata: singleScaleMetadata(TARGET_LAYER, "uint32"),
    voxelPosition: [32, 32, Z],
    radius: opts.radius,
    value: 7,
    mask: {
      imageLayerId: IMAGE_LAYER,
      imageResolution: RES,
      thresholdLow: BAND_LOW,
      thresholdHigh: BAND_HIGH,
      minComponentSize: opts.minComponentSize,
      binaryClosing: opts.binaryClosing,
      filterComponentsFirst: false,
    },
    maskMetadata: singleScaleMetadata(IMAGE_LAYER, "uint8"),
    readChunk: async () => image,
    readChunkAt: async (
      _layerId: LayerId,
      _resolution: Resolution,
      _chunkId: ChunkId,
    ) => image,
  };
}

function paintedVoxelSet(batch: PaintWriteBatch): Set<string> {
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

/** Fake worker client: records requests, applies an identity transform. */
function fakeMorphologyClient(calls: MorphologyRequest[]): MorphologyClient {
  return {
    apply: async (req: MorphologyRequest) => {
      calls.push(req);
      return req.mask;
    },
  } as unknown as MorphologyClient;
}

describe("PaintingCompute morphology input crop + empty-mask skip", () => {
  it("sends the worker only the set-byte bbox padded by the closing reach", async () => {
    const calls: MorphologyRequest[] = [];
    const compute = new PaintingCompute(fakeMorphologyClient(calls));
    // 4×4 in-band square at [30..33]² inside a 17×17 footprint (r=8 around 32):
    // mask bbox is i,j ∈ [6..9]; pad = closing + 1 = 2 → crop [4..11]² = 8×8.
    const square: (readonly [number, number])[] = [];
    for (let y = 30; y <= 33; y++)
      for (let x = 30; x <= 33; x++) square.push([x, y]);
    const batch = await compute.applyBrush(
      brushInput(imageChunkWith(square), {
        radius: 8,
        binaryClosing: 1,
        minComponentSize: 2,
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].shape).toEqual([8, 8, 1]);
    // Identity morphology → painted set is exactly the square; this also
    // proves the crop paste-back lands at the right absolute coordinates.
    const painted = paintedVoxelSet(batch);
    expect(painted.size).toBe(16);
    for (const [x, y] of square) {
      expect(painted.has(`${x},${y},${Z}`)).toBe(true);
    }
  });

  it("skips the worker round-trip entirely when the threshold mask is empty", async () => {
    const calls: MorphologyRequest[] = [];
    const compute = new PaintingCompute(fakeMorphologyClient(calls));
    const batch = await compute.applyBrush(
      brushInput(imageChunkWith([]), {
        radius: 8,
        binaryClosing: 1,
        minComponentSize: 32,
      }),
    );
    expect(calls).toHaveLength(0);
    expect(paintedVoxelSet(batch).size).toBe(0);
  });

  it("cropped morphology is bit-identical to the full-footprint pipeline", async () => {
    // Pattern exercising both ops near the mask bbox edge: scattered specks,
    // an L-blob that survives the size filter, and an isolated speck that
    // min-component-size must remove.
    const pixels: (readonly [number, number])[] = [
      [27, 32],
      [29, 32], // specks — too small for minSize=3
      [30, 30],
      [30, 31],
      [31, 30], // L-blob — size 3, kept
      [38, 32], // isolated → filtered (minSize=3)
    ];
    const radius = 8;
    const binaryClosing = 1;
    const minComponentSize = 3;

    // Compute under test (in-process TS fallback; crop applies before it).
    const compute = new PaintingCompute();
    const batch = await compute.applyBrush(
      brushInput(imageChunkWith(pixels), {
        radius,
        binaryClosing,
        minComponentSize,
      }),
    );
    const painted = paintedVoxelSet(batch);

    // Reference: the same mask built over the FULL footprint bbox, run through
    // the same TS pipeline uncropped.
    const cx = 32;
    const cy = 32;
    const lo = cx - radius;
    const w = 2 * radius + 1;
    const inBand = new Set(pixels.map(([x, y]) => `${x},${y}`));
    const full = new Uint8Array(w * w);
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const x = lo + i;
        const y = lo + j;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (inBand.has(`${x},${y}`)) full[i + w * j] = 1;
      }
    }
    const expected = applyMorphologyPipeline({
      mask: { data: full, shape: [w, w, 1] },
      binaryClosing,
      minComponentSize,
      filterComponentsFirst: false,
    }).data;
    const expectedSet = new Set<string>();
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        if (expected[i + w * j] !== 1) continue;
        const x = lo + i;
        const y = lo + j;
        const dx = x - cx;
        const dy = y - cy;
        // The write loop only stamps in-footprint voxels.
        if (dx * dx + dy * dy > radius * radius) continue;
        expectedSet.add(`${x},${y},${Z}`);
      }
    }

    expect(painted.size).toBe(expectedSet.size);
    for (const v of painted) expect(expectedSet.has(v)).toBe(true);
    // Sanity on the scenario itself: the L-blob survived the size filter,
    // the isolated speck did not.
    expect(painted.has(`30,30,${Z}`)).toBe(true);
    expect(painted.has(`38,32,${Z}`)).toBe(false);
  });
});
