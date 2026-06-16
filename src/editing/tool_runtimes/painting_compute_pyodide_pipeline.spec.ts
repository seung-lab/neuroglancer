/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Parity matrix for the pyodide whole-pipeline masked-brush path (TM-317).
 *
 * Asserts that routing a masked stamp through the worker (here stood in for by
 * the `runPaintPipelineTS` twin, exactly as the existing morphology tests stand
 * in the worker with `applyMorphologyPipeline`) produces a paint batch
 * BYTE-IDENTICAL to the unchanged main-thread masked compute, across the full
 * matrix the task requires: closing ∈ {0,1,3}, minComponentSize ∈ {1,32},
 * filterComponentsFirst ∈ {false,true}, threshold edge-inclusivity, eraser
 * (value 0), anisotropic target↔image resolutions, capsule/polyline footprints,
 * and a footprint spanning multiple chunks.
 *
 * The real python↔twin equivalence is checked separately in
 * `paint_pipeline_pyodide_live.spec.ts`.
 */

import type {
  ChunkId,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdCtor,
  Resolution as ResolutionCtor,
  layerId,
} from "@zettaai/edit-session";

import { describe, it, expect } from "vitest";

import type { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type { PaintPipelineRequest } from "#src/editing/tool_runtimes/paint_pipeline_request.js";
import { runPaintPipelineTS } from "#src/editing/tool_runtimes/paint_pipeline_ts.js";
import type {
  BrushApplyInput,
  BrushStrokeInput,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET_LAYER: LayerId = layerId("target");
const IMAGE_LAYER: LayerId = layerId("image");
const CHUNK = 64;
const Z = 32;
const BAND_LOW = 90;
const BAND_HIGH = 150;

/** Deterministic image value at an absolute IMAGE voxel; spans the band edges. */
function imageValueAt(x: number, y: number): number {
  // 80..160 inclusive — straddles [90,150] so threshold edge-inclusivity (==90,
  // ==150) and just-outside (==89, ==151) are both exercised.
  const m = (((x * 7 + y * 13) % 81) + 81) % 81;
  return 80 + m;
}

function metadataAt(
  id: LayerId,
  voxelDataType: LayerMetadata["voxelDataType"],
  resolution: Resolution,
  voxelSizeNm: readonly [number, number, number],
): LayerMetadata {
  return {
    layerId: id,
    voxelDataType,
    channels: 1,
    scales: [
      {
        resolution,
        voxelSizeNm: [voxelSizeNm[0], voxelSizeNm[1], voxelSizeNm[2]],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [CHUNK * 8, CHUNK * 8, CHUNK * 8],
        chunkDataSize: [CHUNK, CHUNK, CHUNK],
      },
    ],
  };
}

/**
 * Image reader: builds the requested image chunk on the fly, filling each voxel
 * from `imageValueAt` (z-independent). Decodes the chunk coord from the chunk
 * id so footprints spanning multiple chunks resolve correctly.
 */
const readImageChunk = async (
  _layerId: LayerId,
  _resolution: Resolution,
  chunkId: ChunkId,
): Promise<ReadonlyChunkVoxelBuffer> => {
  const coord = ChunkIdCtor.toCoord(chunkId);
  const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
  const baseX = coord.x * CHUNK;
  const baseY = coord.y * CHUNK;
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const v = imageValueAt(baseX + lx, baseY + ly);
      for (let lz = 0; lz < CHUNK; lz++) {
        data[lx + CHUNK * (ly + CHUNK * lz)] = v;
      }
    }
  }
  return { byteLength: data.byteLength, asView: () => data };
};

const readTargetChunk = async (): Promise<ReadonlyChunkVoxelBuffer> => {
  const data = new Uint32Array(CHUNK * CHUNK * CHUNK);
  return { byteLength: data.byteLength, asView: () => data };
};

interface MaskCfg {
  binaryClosing: number;
  minComponentSize: number;
  filterComponentsFirst: boolean;
}

interface SceneCfg {
  /** Target voxel size (nm) — drives target↔image anisotropy vs the image. */
  targetVoxelSizeNm: readonly [number, number, number];
  imageVoxelSizeNm: readonly [number, number, number];
  value: number | bigint;
}

function maskConfig(scene: SceneCfg, m: MaskCfg) {
  return {
    imageLayerId: IMAGE_LAYER,
    imageResolution: ResolutionCtor.from([
      scene.imageVoxelSizeNm[0],
      scene.imageVoxelSizeNm[1],
      scene.imageVoxelSizeNm[2],
    ]),
    thresholdLow: BAND_LOW,
    thresholdHigh: BAND_HIGH,
    minComponentSize: m.minComponentSize,
    binaryClosing: m.binaryClosing,
    filterComponentsFirst: m.filterComponentsFirst,
  };
}

function commonInput(scene: SceneCfg, m: MaskCfg) {
  const targetRes = ResolutionCtor.from([
    scene.targetVoxelSizeNm[0],
    scene.targetVoxelSizeNm[1],
    scene.targetVoxelSizeNm[2],
  ]);
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: targetRes,
    metadata: metadataAt(
      TARGET_LAYER,
      "uint32",
      targetRes,
      scene.targetVoxelSizeNm,
    ),
    value: scene.value,
    mask: maskConfig(scene, m),
    maskMetadata: metadataAt(
      IMAGE_LAYER,
      "uint8",
      maskConfig(scene, m).imageResolution,
      scene.imageVoxelSizeNm,
    ),
    readChunk: readTargetChunk,
    readChunkAt: readImageChunk,
  };
}

function clickInput(
  scene: SceneCfg,
  m: MaskCfg,
  pos: readonly [number, number, number],
  radius: number,
): BrushApplyInput {
  return { ...commonInput(scene, m), voxelPosition: pos, radius };
}

function strokeInput(
  scene: SceneCfg,
  m: MaskCfg,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  radius: number,
  via?: readonly (readonly [number, number, number])[],
): BrushStrokeInput {
  return {
    ...commonInput(scene, m),
    from,
    to,
    ...(via !== undefined ? { via } : {}),
    radius,
    stepVoxels: Math.max(1, Math.floor(radius / 2)),
  };
}

/** Fake worker client: ready, whole-pipeline served by the TS twin. */
function fakePipelineClient(): MorphologyClient {
  return {
    isReady: () => true,
    applyPipeline: async (req: PaintPipelineRequest) => runPaintPipelineTS(req),
  } as unknown as MorphologyClient;
}

/**
 * Canonical, order-independent signature of a batch: painted voxels (`valueMask`
 * set) as `"x,y,z=value"`, plus the emitted per-chunk subregions. Byte parity
 * means both signatures match.
 */
function canonicalize(batch: PaintWriteBatch): {
  painted: string[];
  regions: string[];
} {
  const painted: string[] = [];
  const regions: string[] = [];
  for (const chunk of batch.chunks) {
    const [ox, oy, oz] = chunk.subregion.origin;
    const [w, h, d] = chunk.subregion.size;
    const baseX = chunk.chunkCoord.x * CHUNK + ox;
    const baseY = chunk.chunkCoord.y * CHUNK + oy;
    const baseZ = chunk.chunkCoord.z * CHUNK + oz;
    regions.push(
      `${chunk.chunkCoord.x},${chunk.chunkCoord.y},${chunk.chunkCoord.z}:` +
        `${ox},${oy},${oz}+${w},${h},${d}`,
    );
    const mask = chunk.valueMask;
    for (let i = 0; i < chunk.values.length; i++) {
      if (mask !== undefined && mask[i] === 0) continue;
      const x = baseX + (i % w);
      const y = baseY + (Math.floor(i / w) % h);
      const z = baseZ + Math.floor(i / (w * h));
      painted.push(`${x},${y},${z}=${String(chunk.values[i])}`);
    }
  }
  painted.sort();
  regions.sort();
  return { painted, regions };
}

async function expectParity(
  run: (compute: PaintingCompute) => Promise<PaintWriteBatch>,
): Promise<{ paintedCount: number }> {
  const current = await run(new PaintingCompute());
  const pipeline = await run(new PaintingCompute(fakePipelineClient()));
  const cc = canonicalize(current);
  const cp = canonicalize(pipeline);
  expect(cp.painted).toEqual(cc.painted);
  expect(cp.regions).toEqual(cc.regions);
  return { paintedCount: cc.painted.length };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const ISO: SceneCfg = {
  targetVoxelSizeNm: [8, 8, 40],
  imageVoxelSizeNm: [8, 8, 40],
  value: 7,
};
const COARSE_IMAGE: SceneCfg = {
  targetVoxelSizeNm: [8, 8, 40],
  imageVoxelSizeNm: [16, 16, 40], // image coarser → sxRatio 0.5
  value: 7,
};
const FINE_IMAGE: SceneCfg = {
  targetVoxelSizeNm: [16, 16, 40],
  imageVoxelSizeNm: [8, 8, 40], // image finer → sxRatio 2
  value: 7,
};

const CLOSINGS = [0, 1, 3];
const MIN_SIZES = [1, 32];
const FCF = [false, true];

describe("PaintingCompute whole-pipeline parity (TM-317)", () => {
  for (const binaryClosing of CLOSINGS) {
    for (const minComponentSize of MIN_SIZES) {
      for (const filterComponentsFirst of FCF) {
        const m: MaskCfg = {
          binaryClosing,
          minComponentSize,
          filterComponentsFirst,
        };
        const label = `closing=${binaryClosing} minSize=${minComponentSize} fcf=${filterComponentsFirst}`;

        it(`click parity — ${label}`, async () => {
          const { paintedCount } = await expectParity((c) =>
            c.applyBrush(clickInput(ISO, m, [100, 100, Z], 14)),
          );
          // Guard against a vacuously-passing all-empty case.
          expect(paintedCount).toBeGreaterThan(0);
        });

        it(`capsule parity — ${label}`, async () => {
          await expectParity((c) =>
            c.applyBrushStroke(
              strokeInput(ISO, m, [90, 100, Z], [130, 112, Z], 12),
            ),
          );
        });
      }
    }
  }

  it("polyline (coalesced via) parity", async () => {
    const m: MaskCfg = {
      binaryClosing: 1,
      minComponentSize: 8,
      filterComponentsFirst: false,
    };
    await expectParity((c) =>
      c.applyBrushStroke(
        strokeInput(ISO, m, [80, 90, Z], [150, 130, Z], 10, [
          [110, 95, Z],
          [128, 120, Z],
        ]),
      ),
    );
  });

  it("eraser (value 0) parity — morphology config still honoured", async () => {
    const scene: SceneCfg = { ...ISO, value: 0 };
    const m: MaskCfg = {
      binaryClosing: 1,
      minComponentSize: 4,
      filterComponentsFirst: false,
    };
    await expectParity((c) =>
      c.applyBrush(clickInput(scene, m, [100, 100, Z], 14)),
    );
  });

  it("anisotropic (coarse image, sxRatio 0.5) parity", async () => {
    const m: MaskCfg = {
      binaryClosing: 1,
      minComponentSize: 6,
      filterComponentsFirst: true,
    };
    const { paintedCount } = await expectParity((c) =>
      c.applyBrush(clickInput(COARSE_IMAGE, m, [100, 100, Z], 16)),
    );
    expect(paintedCount).toBeGreaterThan(0);
  });

  it("anisotropic (fine image, sxRatio 2) parity", async () => {
    const m: MaskCfg = {
      binaryClosing: 3,
      minComponentSize: 1,
      filterComponentsFirst: false,
    };
    const { paintedCount } = await expectParity((c) =>
      c.applyBrushStroke(
        strokeInput(FINE_IMAGE, m, [40, 50, Z], [70, 58, Z], 10),
      ),
    );
    expect(paintedCount).toBeGreaterThan(0);
  });

  it("footprint spanning multiple chunks parity", async () => {
    const m: MaskCfg = {
      binaryClosing: 1,
      minComponentSize: 16,
      filterComponentsFirst: false,
    };
    // Center near the (64,64) chunk corner with a radius crossing into all four
    // neighbouring chunks.
    const { paintedCount } = await expectParity((c) =>
      c.applyBrush(clickInput(ISO, m, [62, 62, Z], 18)),
    );
    expect(paintedCount).toBeGreaterThan(0);
  });
});
