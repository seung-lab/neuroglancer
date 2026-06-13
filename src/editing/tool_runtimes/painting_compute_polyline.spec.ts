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

import type {
  BrushStrokeInput,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import { describe, it, expect } from "vitest";

import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RES: Resolution = ResolutionCtor.from([8, 8, 40]);
const TARGET_LAYER: LayerId = layerId("target");
const IMAGE_LAYER: LayerId = layerId("image");

const CHUNK = 64;

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

function zeroImageChunk(): ReadonlyChunkVoxelBuffer {
  const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
  return { byteLength: data.byteLength, asView: () => data };
}

const PAINT_VALUE = 7;

function strokeInput(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  via?: readonly (readonly [number, number, number])[],
  radius = 4,
): BrushStrokeInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: RES,
    metadata: singleScaleMetadata(TARGET_LAYER, "uint32"),
    from,
    to,
    ...(via !== undefined ? { via } : {}),
    stepVoxels: 1,
    radius,
    value: PAINT_VALUE,
    readChunk: async () => zeroImageChunk(),
    readChunkAt: async (
      _layerId: LayerId,
      _resolution: Resolution,
      _chunkId: ChunkId,
    ) => zeroImageChunk(),
  };
}

/** Mask whose band accepts the all-zero image everywhere (footprint = mask). */
function allPassMask(input: BrushStrokeInput): BrushStrokeInput {
  return {
    ...input,
    mask: {
      imageLayerId: IMAGE_LAYER,
      imageResolution: RES,
      thresholdLow: 0,
      thresholdHigh: 255,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    },
    maskMetadata: singleScaleMetadata(IMAGE_LAYER, "uint8"),
  };
}

/** Absolute coordinates of every voxel a batch actually paints. */
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

function union(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

// An L-shaped path: coalescing it into one straight capsule would cut the
// corner, so equality with the per-pair union proves the polyline follows
// the real path.
const FROM: readonly [number, number, number] = [20, 20, 32];
const MID: readonly [number, number, number] = [40, 20, 32];
const TO: readonly [number, number, number] = [40, 40, 32];

describe("PaintingCompute polyline stroke (coalesced via points)", () => {
  it("unmasked: polyline paints exactly the union of its per-pair capsules", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const poly = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO, [MID])),
    );
    const pair1 = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, MID)),
    );
    const pair2 = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(MID, TO)),
    );
    const expected = union(pair1, pair2);
    expect(poly.size).toBe(expected.size);
    for (const v of poly) expect(expected.has(v)).toBe(true);
  });

  it("unmasked: polyline differs from the straight from→to capsule (corner kept)", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const poly = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO, [MID])),
    );
    const straight = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO)),
    );
    // The corner voxel around MID is covered by the polyline but not by the
    // straight diagonal capsule.
    expect(poly.has(`${MID[0]},${MID[1]},${MID[2]}`)).toBe(true);
    expect(poly.size).not.toBe(straight.size);
  });

  it("masked (all-pass band, no morphology): same union as unmasked", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const masked = paintedVoxelSet(
      await compute.applyBrushStroke(allPassMask(strokeInput(FROM, TO, [MID]))),
    );
    const unmasked = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO, [MID])),
    );
    expect(masked.size).toBe(unmasked.size);
    for (const v of masked) expect(unmasked.has(v)).toBe(true);
  });

  it("masked (excluding band): polyline paints nothing", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const input = allPassMask(strokeInput(FROM, TO, [MID]));
    const excluded: BrushStrokeInput = {
      ...input,
      mask: { ...input.mask!, thresholdLow: 1 },
    };
    const batch = await compute.applyBrushStroke(excluded);
    expect(paintedVoxelSet(batch).size).toBe(0);
  });

  it("via points duplicating the endpoints collapse to the plain capsule", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const withDupVia = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO, [FROM, TO])),
    );
    const plain = paintedVoxelSet(
      await compute.applyBrushStroke(strokeInput(FROM, TO)),
    );
    expect(withDupVia.size).toBe(plain.size);
    for (const v of withDupVia) expect(plain.has(v)).toBe(true);
  });

  it("r=0 fallback: dabs follow every pair of the polyline", async () => {
    const compute = new PaintingCompute(() => "painting.brush");
    const batch = await compute.applyBrushStroke(
      strokeInput([20, 20, 32], [24, 24, 32], [[24, 20, 32]], 0),
    );
    const painted = paintedVoxelSet(batch);
    // Both pair endpoints are stamped by the per-pair dab interpolation.
    expect(painted.has("24,20,32")).toBe(true);
    expect(painted.has("24,24,32")).toBe(true);
  });
});
