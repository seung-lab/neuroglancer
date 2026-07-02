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
 * PaintingCompute DATA MATRIX (TM-331, phase 1).
 *
 * The hand-written behavioural cases live in `painting_compute.spec.ts`; this
 * file is the parametrized regression net that systematically sweeps the *data*
 * axes through the in-memory compute kernel — fast (no app / GPU / `gs://`),
 * deterministic, runs in `npm test`. Each axis combination is its own `it(...)`
 * so a regression names the exact `{dtype × chunk × radius}` that broke.
 *
 * Axes covered here (the ones `PaintingCompute` actually branches on):
 *   - voxelDataType — drives `allocateVoxelBuffer` (8 typed-array kinds) and the
 *     `number | bigint` value path + range clamping (`clampToVoxelDataType`).
 *   - chunkDataSize — incl. a dimension > 4096 (large-chunk index math) and a
 *     tiny chunk so a stamp straddles a chunk boundary and splits.
 *   - radius / stroke — single voxel, disk footprint, boundary split.
 *   - mask path across target dtypes (image stays uint8, full band).
 *
 * Deliberately DEFERRED (would assert wrong things without more wiring — tracked
 * on TM-331, phase 2 e2e):
 *   - target-layer `voxelOffset`: a NO-OP at this layer — the target chunk coord
 *     is `floor(voxelPosition / chunkDataSize)`, the offset is never subtracted
 *     (the caller passes offset-relative positions). Exercised end-to-end only
 *     when the full pointer→voxel transform runs (phase 2).
 *   - image/mask `voxelOffset` alignment + target-coarser-than-image (>1×)
 *     multi-resolution: real axes, but a correct assertion needs the
 *     `mask_coord.ts` target→image mapping + the offset-anchored chunk coords
 *     (`painting_compute.ts:1205,1582`). One 2× case lives in the behavioural
 *     spec; the offset/coverage sweep is phase 2.
 *   - encoding (raw/jpeg/compressed_segmentation): nothing is serialized here,
 *     so encoding is invisible to the kernel — it's a phase-2 e2e axis.
 *   - locked/writable layers: a session-host concern, not a compute concern.
 */

import type {
  ChunkId as ChunkIdType,
  ChunkVoxelBuffer,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  VoxelDataType,
} from "@zettaai/edit-session";
import { Resolution, layerId } from "@zettaai/edit-session";

import { describe, it, expect } from "vitest";

import type {
  BrushApplyInput,
  BrushStrokeInput,
  FillInput,
  PaintChunkWrite,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";

type Vec3 = readonly [number, number, number];

const TARGET_RES = Resolution.from([8, 8, 40]);
const TARGET_LAYER = layerId("L1");
const MASK_LAYER = layerId("M1");

// ---------------------------------------------------------------------------
// Axis definitions
// ---------------------------------------------------------------------------

interface DtypeCase {
  readonly type: VoxelDataType;
  readonly View: { new (length: number): ChunkVoxelBuffer };
  /** An in-range paint value of the dtype's JS kind (bigint for uint64). */
  readonly value: number | bigint;
  /** Optional out-of-range value + the bound `clampToVoxelDataType` pins it to. */
  readonly overflow?: { in: number | bigint; out: number | bigint };
}

const DTYPES: readonly DtypeCase[] = [
  {
    type: "uint8",
    View: Uint8Array,
    value: 200,
    overflow: { in: 300, out: 255 },
  },
  {
    type: "int8",
    View: Int8Array,
    value: 100,
    overflow: { in: 200, out: 127 },
  },
  {
    type: "uint16",
    View: Uint16Array,
    value: 5000,
    overflow: { in: 70000, out: 65535 },
  },
  {
    type: "int16",
    View: Int16Array,
    value: 1000,
    overflow: { in: 40000, out: 32767 },
  },
  { type: "uint32", View: Uint32Array, value: 100000 },
  { type: "int32", View: Int32Array, value: 100000 },
  { type: "float32", View: Float32Array, value: 1.5 },
  { type: "uint64", View: BigUint64Array, value: 42n },
];

/** Small chunks: full dtype × radius cross (cheap allocations). */
const SMALL_CHUNKS: readonly Vec3[] = [
  [64, 64, 64],
  [8, 8, 8],
];

/**
 * A chunk whose X dimension is > 4096 — exercises the large-chunk index math
 * (`floor(x / csx)` + the `x + sx*(y + sy*z)` linear index) without a giant
 * allocation: the thin Y/Z keep one chunk at 8192·64·1 = 512Ki voxels.
 */
const LARGE_CHUNK: Vec3 = [8192, 64, 1];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function metadata(
  dtype: VoxelDataType,
  chunk: Vec3,
  size: Vec3 = [16384, 16384, 64],
): LayerMetadata {
  return {
    layerId: TARGET_LAYER,
    voxelDataType: dtype,
    channels: 1,
    scales: [
      {
        resolution: TARGET_RES,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: size,
        chunkDataSize: chunk,
      },
    ],
  };
}

/** Zero-filled reader allocating the dtype's typed array per chunk. */
function zeroReader(
  dtype: DtypeCase,
  chunk: Vec3,
): (chunkId: ChunkIdType) => Promise<ReadonlyChunkVoxelBuffer> {
  const volume = chunk[0] * chunk[1] * chunk[2];
  return async () => {
    const view = new dtype.View(volume);
    return { byteLength: view.byteLength, asView: () => view };
  };
}

const unusedReadChunkAt = async () => {
  throw new Error("readChunkAt unused in this test");
};

/** uint8 image metadata for the mask path. */
function imageMetadata(chunk: Vec3): LayerMetadata {
  return {
    layerId: MASK_LAYER,
    voxelDataType: "uint8",
    channels: 1,
    scales: [
      {
        resolution: TARGET_RES,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [16384, 16384, 64],
        chunkDataSize: chunk,
      },
    ],
  };
}

/** Constant-value uint8 image reader (full-band mask). */
function constImageReader(
  chunk: Vec3,
  v: number,
): (
  l: unknown,
  r: unknown,
  c: ChunkIdType,
) => Promise<ReadonlyChunkVoxelBuffer> {
  const volume = chunk[0] * chunk[1] * chunk[2];
  return async () => {
    const buf = new Uint8Array(volume).fill(v);
    return { byteLength: buf.byteLength, asView: () => buf };
  };
}

/** Matches `stampDisk2D`: integer (dx,dy) with dx²+dy² ≤ r². */
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

function countSet(batch: { chunks: readonly PaintChunkWrite[] }): number {
  let n = 0;
  for (const c of batch.chunks) {
    for (const b of c.valueMask ?? []) if (b !== 0) n++;
  }
  return n;
}

/** Value of the first mask-set voxel across the batch (dtype's JS kind). */
function sampleSetValue(batch: {
  chunks: readonly PaintChunkWrite[];
}): number | bigint | undefined {
  for (const c of batch.chunks) {
    const mask = c.valueMask;
    const n = mask?.length ?? 0;
    for (let i = 0; i < n; i++) {
      if (mask![i] !== 0) return (c.values as ArrayLike<number | bigint>)[i];
    }
  }
  return undefined;
}

/** GLOBAL coords of every mask-set voxel (mirrors painting_compute.spec). */
function writtenVoxels(
  batch: { chunks: readonly PaintChunkWrite[] },
  chunk: Vec3,
): Array<[number, number, number]> {
  const [sx, sy, sz] = chunk;
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

function expectVoxelValue(
  actual: number | bigint | undefined,
  expected: number | bigint,
  dtype: VoxelDataType,
): void {
  if (dtype === "float32") {
    expect(Number(actual)).toBeCloseTo(Number(expected), 5);
  } else {
    expect(actual).toBe(expected);
  }
}

function brushInput(
  dtype: DtypeCase,
  chunk: Vec3,
  voxelPosition: Vec3,
  radius: number,
  value: number | bigint = dtype.value,
): BrushApplyInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: TARGET_RES,
    metadata: metadata(dtype.type, chunk),
    voxelPosition,
    radius,
    value,
    readChunk: zeroReader(dtype, chunk),
    readChunkAt: unusedReadChunkAt,
  };
}

// ---------------------------------------------------------------------------
// dtype × chunk — value buffer, clamping, footprint
// ---------------------------------------------------------------------------

describe("PaintingCompute data matrix — dtype × chunk", () => {
  for (const dtype of DTYPES) {
    describe(dtype.type, () => {
      for (const chunk of SMALL_CHUNKS) {
        const tag = `chunk ${chunk.join("×")}`;

        it(`${tag}: radius 0 writes a single typed voxel`, async () => {
          const compute = new PaintingCompute();
          // Center well inside one chunk so nothing crosses a boundary.
          const center: Vec3 = [chunk[0] >> 1, chunk[1] >> 1, chunk[2] >> 1];
          const batch = await compute.applyBrush(
            brushInput(dtype, chunk, center, 0),
          );
          expect(batch.chunks).toHaveLength(1);
          const c = batch.chunks[0];
          expect(c.subregion.size).toEqual([1, 1, 1]);
          expect(c.values).toBeInstanceOf(dtype.View);
          expectVoxelValue(
            (c.values as ArrayLike<number | bigint>)[0],
            dtype.value,
            dtype.type,
          );
          expect(c.valueMask![0]).toBe(1);
        });

        it(`${tag}: radius 3 stamps the disk footprint`, async () => {
          const compute = new PaintingCompute();
          // [8,8,8] is too small for a radius-3 disk to stay in one chunk, so
          // assert the footprint is preserved across however many chunks split.
          const center: Vec3 = [chunk[0] >> 1, chunk[1] >> 1, chunk[2] >> 1];
          const batch = await compute.applyBrush(
            brushInput(dtype, chunk, center, 3),
          );
          expect(countSet(batch)).toBe(diskFootprint(3));
          expectVoxelValue(sampleSetValue(batch), dtype.value, dtype.type);
        });
      }

      if (dtype.overflow !== undefined) {
        it(`clamps an out-of-range value to the dtype bound`, async () => {
          const compute = new PaintingCompute();
          const batch = await compute.applyBrush(
            brushInput(
              dtype,
              [64, 64, 64],
              [32, 32, 32],
              0,
              dtype.overflow!.in,
            ),
          );
          expectVoxelValue(
            sampleSetValue(batch),
            dtype.overflow!.out,
            dtype.type,
          );
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Boundary straddle — a stamp split across two chunks preserves its footprint
// ---------------------------------------------------------------------------

describe("PaintingCompute data matrix — chunk-boundary split", () => {
  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: a disk straddling x=8 splits across two chunks`, async () => {
      const compute = new PaintingCompute();
      const chunk: Vec3 = [8, 8, 8];
      // x=7 is the last voxel of chunk (0,*,*); radius 2 reaches into chunk 1.
      const batch = await compute.applyBrush(
        brushInput(dtype, chunk, [7, 4, 4], 2),
      );
      expect(batch.chunks.length).toBe(2);
      expect(countSet(batch)).toBe(diskFootprint(2));
    });
  }
});

// ---------------------------------------------------------------------------
// Large chunk (> 4096) — index math without giant allocations
// ---------------------------------------------------------------------------

describe("PaintingCompute data matrix — large chunk (>4096)", () => {
  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: radius 0 deep inside an 8192-wide chunk lands at the right global voxel`, async () => {
      const compute = new PaintingCompute();
      const pos: Vec3 = [5000, 20, 0];
      const batch = await compute.applyBrush(
        brushInput(dtype, LARGE_CHUNK, pos, 0),
      );
      expect(batch.chunks).toHaveLength(1);
      expect(batch.chunks[0].chunkCoord.x).toBe(0);
      expect(writtenVoxels(batch, LARGE_CHUNK)).toEqual([[5000, 20, 0]]);
    });

    it(`${dtype.type}: a disk straddling x=8192 splits and preserves its footprint`, async () => {
      const compute = new PaintingCompute();
      // x=8191 is the last voxel of chunk 0; radius 2 reaches x=8193 in chunk 1.
      const batch = await compute.applyBrush(
        brushInput(dtype, LARGE_CHUNK, [8191, 20, 0], 2),
      );
      expect(batch.chunks.length).toBe(2);
      const xs = new Set(batch.chunks.map((c) => c.chunkCoord.x));
      expect(xs).toEqual(new Set([0, 1]));
      expect(countSet(batch)).toBe(diskFootprint(2));
    });
  }
});

// ---------------------------------------------------------------------------
// Mask path across target dtypes — full band paints the disk with typed values
// ---------------------------------------------------------------------------

describe("PaintingCompute data matrix — masked brush across target dtypes", () => {
  const chunk: Vec3 = [64, 64, 64];
  for (const dtype of DTYPES) {
    it(`${dtype.type}: full-band mask paints the disk footprint`, async () => {
      const compute = new PaintingCompute();
      const batch = await compute.applyBrush({
        targetLayerId: TARGET_LAYER,
        targetResolution: TARGET_RES,
        metadata: metadata(dtype.type, chunk),
        voxelPosition: [32, 32, 16],
        radius: 3,
        value: dtype.value,
        mask: {
          imageLayerId: MASK_LAYER,
          imageResolution: TARGET_RES,
          thresholdLow: 0,
          thresholdHigh: 255,
          minComponentSize: 0,
          binaryClosing: 0,
          filterComponentsFirst: false,
        },
        maskMetadata: imageMetadata(chunk),
        readChunk: zeroReader(dtype, chunk),
        readChunkAt: constImageReader(chunk, 128),
      });
      expect(countSet(batch)).toBe(diskFootprint(3));
      expectVoxelValue(sampleSetValue(batch), dtype.value, dtype.type);
    });
  }
});

// ---------------------------------------------------------------------------
// Stroke matrix (applyBrushStroke) — gap-free coverage + typed values
// ---------------------------------------------------------------------------

function strokeInput(
  dtype: DtypeCase,
  chunk: Vec3,
  from: Vec3,
  to: Vec3,
  radius: number,
  value: number | bigint = dtype.value,
): BrushStrokeInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: TARGET_RES,
    metadata: metadata(dtype.type, chunk),
    from,
    to,
    radius,
    value,
    stepVoxels: 1,
    readChunk: zeroReader(dtype, chunk),
    readChunkAt: unusedReadChunkAt,
  };
}

/** Sorted distinct global X of painted voxels on a fixed (y,z) centerline. */
function paintedXsOnRow(
  batch: { chunks: readonly PaintChunkWrite[] },
  chunk: Vec3,
  y: number,
  z: number,
): number[] {
  const xs = new Set<number>();
  for (const [gx, gy, gz] of writtenVoxels(batch, chunk)) {
    if (gy === y && gz === z) xs.add(gx);
  }
  return Array.from(xs).sort((a, b) => a - b);
}

describe("PaintingCompute data matrix — stroke (applyBrushStroke)", () => {
  for (const dtype of DTYPES) {
    for (const chunk of SMALL_CHUNKS) {
      const tag = `chunk ${chunk.join("×")}`;
      it(`${dtype.type} ${tag}: axis-aligned radius-0 stroke is gap-free with typed values`, async () => {
        const compute = new PaintingCompute();
        // `from` is excluded, `to` included → x ∈ [2, 6]. Fits one chunk for
        // both [8³] (x<8) and [64³].
        const batch = await compute.applyBrushStroke(
          strokeInput(dtype, chunk, [1, 4, 4], [6, 4, 4], 0),
        );
        expect(paintedXsOnRow(batch, chunk, 4, 4)).toEqual([2, 3, 4, 5, 6]);
        // radius 0 axis-aligned → every painted voxel is on the centerline.
        expect(writtenVoxels(batch, chunk)).toHaveLength(5);
        expectVoxelValue(sampleSetValue(batch), dtype.value, dtype.type);
      });
    }
  }

  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: a radius-2 capsule covers both endpoints gap-free`, async () => {
      const compute = new PaintingCompute();
      const chunk: Vec3 = [64, 64, 64];
      const batch = await compute.applyBrushStroke(
        strokeInput(dtype, chunk, [16, 32, 16], [40, 32, 16], 2),
      );
      const xs = new Set(paintedXsOnRow(batch, chunk, 32, 16));
      // Capsule includes BOTH endpoints (16..40), unlike the radius-0 case.
      for (let x = 16; x <= 40; x++) expect(xs.has(x)).toBe(true);
    });
  }

  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: a radius-0 stroke straddling x=8192 stays gap-free across chunks`, async () => {
      const compute = new PaintingCompute();
      // from excluded → x ∈ [8189, 8195], crossing the chunk-0/1 boundary at 8192.
      const batch = await compute.applyBrushStroke(
        strokeInput(dtype, LARGE_CHUNK, [8188, 20, 0], [8195, 20, 0], 0),
      );
      expect(new Set(batch.chunks.map((c) => c.chunkCoord.x))).toEqual(
        new Set([0, 1]),
      );
      const expected = [];
      for (let x = 8189; x <= 8195; x++) expected.push(x);
      expect(paintedXsOnRow(batch, LARGE_CHUNK, 20, 0)).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Fill matrix (PaintingCompute.fill) — bounded floods across dtype × chunk
// ---------------------------------------------------------------------------

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

function fillInput(
  dtype: DtypeCase,
  chunk: Vec3,
  seed: Vec3,
  b: Bounds,
  mode: "2d" | "3d",
  value: number | bigint = dtype.value,
): FillInput {
  return {
    targetLayerId: TARGET_LAYER,
    targetResolution: TARGET_RES,
    metadata: metadata(dtype.type, chunk),
    seedVoxelPosition: seed,
    value,
    mode,
    bounds: b,
    readChunk: zeroReader(dtype, chunk),
  };
}

describe("PaintingCompute data matrix — fill", () => {
  // 2D bounded flood of an empty box: fills exactly W×H on the seed's slice,
  // across dtype × chunk (the [8³] case spans several chunks; [64³] is one).
  for (const dtype of DTYPES) {
    for (const chunk of SMALL_CHUNKS) {
      const tag = `chunk ${chunk.join("×")}`;
      it(`${dtype.type} ${tag}: 2D fill covers the bounded box with typed values`, async () => {
        const compute = new PaintingCompute();
        // x∈[2,12) y∈[2,12) z∈[0,1) ⇒ 10×10 = 100 voxels on z=0.
        const batch = await compute.fill(
          fillInput(dtype, chunk, [6, 6, 0], bounds(2, 2, 0, 12, 12, 1), "2d"),
        );
        const voxels = writtenVoxels(batch, chunk);
        expect(voxels).toHaveLength(100);
        expect(voxels.every(([, , z]) => z === 0)).toBe(true);
        expect(batch.truncated).toBeUndefined();
        expectVoxelValue(sampleSetValue(batch), dtype.value, dtype.type);
      });
    }
  }

  // 3D bounded flood propagates across Z (representative dtypes; needs a chunk
  // with Z depth, so [64³]).
  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: 3D fill covers the bounded box and spans Z`, async () => {
      const compute = new PaintingCompute();
      const chunk: Vec3 = [64, 64, 64];
      const batch = await compute.fill(
        fillInput(dtype, chunk, [4, 4, 4], bounds(2, 2, 2, 6, 6, 6), "3d"),
      );
      const voxels = writtenVoxels(batch, chunk);
      expect(voxels).toHaveLength(64); // 4×4×4
      expect(voxels.some(([, , z]) => z !== 4)).toBe(true);
    });
  }

  // maxVoxels cap truncates with a clear reason, keeping exactly the cap.
  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: maxVoxels caps the flood and reports truncation`, async () => {
      const compute = new PaintingCompute();
      const chunk: Vec3 = [64, 64, 64];
      const batch = await compute.fill({
        ...fillInput(
          dtype,
          chunk,
          [32, 32, 32],
          bounds(0, 0, 0, 64, 64, 64),
          "2d",
        ),
        maxVoxels: 50,
      });
      expect(batch.truncated?.reason).toBe("max-voxels");
      expect(batch.truncated?.voxelsWritten).toBe(50);
      expect(writtenVoxels(batch, chunk)).toHaveLength(50);
    });
  }

  // Fill indexing inside a chunk wider than 4096.
  for (const dtype of [DTYPES[0], DTYPES[DTYPES.length - 1]]) {
    it(`${dtype.type}: 2D fill inside an 8192-wide chunk covers the box`, async () => {
      const compute = new PaintingCompute();
      // 20×20 box centred deep in the wide chunk (x≈5000), one chunk touched.
      const batch = await compute.fill(
        fillInput(
          dtype,
          LARGE_CHUNK,
          [5010, 20, 0],
          bounds(5000, 10, 0, 5020, 30, 1),
          "2d",
        ),
      );
      const voxels = writtenVoxels(batch, LARGE_CHUNK);
      expect(voxels).toHaveLength(400);
      expect(
        voxels.every(
          ([x, y, z]) => x >= 5000 && x < 5020 && y >= 10 && y < 30 && z === 0,
        ),
      ).toBe(true);
      expectVoxelValue(sampleSetValue(batch), dtype.value, dtype.type);
    });
  }
});
