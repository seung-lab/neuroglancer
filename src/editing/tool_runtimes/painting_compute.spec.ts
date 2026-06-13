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

// An image chunk that is uniformly zero — so a threshold band of [1, 255]
// excludes every voxel. Under the mask, the brush would paint nothing.
function zeroImageChunk(): ReadonlyChunkVoxelBuffer {
  const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
  return { byteLength: data.byteLength, asView: () => data };
}

const PAINT_VALUE = 7;

/** Brush stamp centred well inside chunk (0,0,0) so the disk never spills out. */
function brushInput(): BrushApplyInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: RES,
    metadata: singleScaleMetadata(TARGET_LAYER, "uint32"),
    voxelPosition: [32, 32, 32],
    radius: 1,
    value: PAINT_VALUE,
    mask: {
      imageLayerId: IMAGE_LAYER,
      imageResolution: RES,
      // Band [1, 255] excludes the all-zero image → fully masked out.
      thresholdLow: 1,
      thresholdHigh: 255,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    },
    maskMetadata: singleScaleMetadata(IMAGE_LAYER, "uint8"),
    readChunk: async () => zeroImageChunk(),
    readChunkAt: async (
      _layerId: LayerId,
      _resolution: Resolution,
      _chunkId: ChunkId,
    ) => zeroImageChunk(),
  };
}

function paintedVoxelCount(batch: PaintWriteBatch): number {
  let painted = 0;
  for (const chunk of batch.chunks) {
    const mask = chunk.valueMask;
    if (mask === undefined) {
      // No gating mask => every voxel in the block is written.
      painted += chunk.values.length;
      continue;
    }
    for (const byte of mask) if (byte !== 0) painted++;
  }
  return painted;
}

// ---------------------------------------------------------------------------
// The compute honors `input.mask` whenever it is present (TM-315). Suppressing
// the mask for the eraser is the tool's concern (it omits `mask`); see
// painting_tools.spec.ts. The compute no longer reaches back to active-tool
// state.
// ---------------------------------------------------------------------------

describe("PaintingCompute honors the supplied mask", () => {
  it("an excluding threshold band paints nothing (applyBrush)", async () => {
    const compute = new PaintingCompute();
    const batch = await compute.applyBrush(brushInput());
    expect(paintedVoxelCount(batch)).toBe(0);
  });

  it("an excluding threshold band paints nothing (applyBrushStroke)", async () => {
    const compute = new PaintingCompute();
    const base = brushInput();
    const batch = await compute.applyBrushStroke({
      ...base,
      from: [32, 32, 32],
      to: [34, 32, 32],
      stepVoxels: 1,
    });
    expect(paintedVoxelCount(batch)).toBe(0);
  });
});
