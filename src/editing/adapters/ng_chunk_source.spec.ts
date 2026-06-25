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
  ChunkVoxelBuffer,
  LayerId,
  OverlayCoord,
  SavedChunk,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  ChunkReadAbortedError,
  ChunkReadFailedError,
  contentRefFromBuffer,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  fetchBaselineWithRetry,
  NgChunkSource,
} from "#src/editing/adapters/ng_chunk_source.js";
import type { LayerManager } from "#src/layer/index.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { DataType } from "#src/util/data_type.js";

const COORD: OverlayCoord = {
  layerId: "seg" as OverlayCoord["layerId"],
  resolution: "8x8x8" as OverlayCoord["resolution"],
  chunkId: ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 }),
};
const GRID = new Float32Array([0, 0, 0]);

interface FetchResult {
  readonly data: ChunkVoxelBuffer | null;
}

/**
 * Minimal fake `VolumeChunkSource` exercising only what
 * `fetchBaselineWithRetry` touches: `spec` (for the zero-fill path) and
 * `fetchChunk`, which awaits `respond(attempt)` then runs the caller's
 * transform with `{ data }`. A rejecting `respond` simulates a thrown fetch
 * error; resolving with `data: null` simulates a sparse / absent chunk.
 */
function makeSource(respond: (attempt: number) => Promise<FetchResult>): {
  source: VolumeChunkSource;
  calls: () => number;
} {
  let calls = 0;
  const source = {
    spec: {
      chunkDataSize: [2, 2, 2],
      dataType: DataType.UINT32,
      compressedSegmentationBlockSize: undefined,
    },
    async fetchChunk(
      _grid: Float32Array,
      transform: (chunk: unknown) => ChunkVoxelBuffer,
    ): Promise<ChunkVoxelBuffer> {
      const attempt = calls++;
      const chunk = await respond(attempt);
      return transform(chunk);
    },
  };
  return { source: source as unknown as VolumeChunkSource, calls: () => calls };
}

describe("fetchBaselineWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the chunk bytes when the fetch succeeds on the first try", async () => {
    const bytes = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { source, calls } = makeSource(async () => ({ data: bytes }));

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(calls()).toBe(1);
  });

  it("zero-fills a sparse chunk (null data) without retrying", async () => {
    const { source, calls } = makeSource(async () => ({ data: null }));

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    // 2x2x2 UINT32 → eight zero voxels.
    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(calls()).toBe(1);
  });

  it("retries a transient error and succeeds", async () => {
    const bytes = Uint32Array.from([9, 9, 9, 9, 9, 9, 9, 9]);
    const { source, calls } = makeSource(async (attempt) => {
      if (attempt < 2) throw new Error("transient");
      return { data: bytes };
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      9, 9, 9, 9, 9, 9, 9, 9,
    ]);
    expect(calls()).toBe(3);
  });

  it("propagates ChunkReadFailedError after exhausting retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("persistent failure");
    const { source, calls } = makeSource(async () => {
      throw cause;
    });

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      undefined,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadFailedError);
    expect(calls()).toBe(3);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws ChunkReadAbortedError without fetching when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { source, calls } = makeSource(async () => ({ data: null }));

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      controller.signal,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadAbortedError);
    expect(calls()).toBe(0);
  });

  it("throws ChunkReadAbortedError when the signal aborts during a fetch", async () => {
    const controller = new AbortController();
    const { source, calls } = makeSource(async () => {
      // Abort mid-flight, then fail: the post-catch abort check must win over
      // a retry, surfacing an abort (not a read failure).
      controller.abort();
      throw new Error("interrupted");
    });

    const error = await fetchBaselineWithRetry(
      source,
      COORD,
      GRID,
      controller.signal,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ChunkReadAbortedError);
    expect(calls()).toBe(1);
  });
});

const LAYER = "seg" as LayerId;
const RES_8 = ResolutionCtor.from([8, 8, 8]);
// 2x2x2 UINT32 chunk → eight voxels (matches the fake source's chunkDataSize).
const SAVED = Uint32Array.from([10, 11, 12, 13, 14, 15, 16, 17]);

interface FakeVolumeSource {
  spec: {
    rank: number;
    chunkDataSize: number[];
    dataType: DataType;
    compressedSegmentationBlockSize: undefined;
  };
  invalidateChunkCache: ReturnType<typeof vi.fn>;
  deleteChunk: ReturnType<typeof vi.fn>;
  chunks: Map<string, unknown>;
  fetchChunk: (
    grid: Float32Array,
    transform: (chunk: unknown) => ChunkVoxelBuffer,
  ) => Promise<ChunkVoxelBuffer>;
}

/**
 * Fake `VolumeChunkSource` exercising what `verifyChunksPersisted` touches:
 * `invalidateCache`, the resident-`chunks` map + `deleteChunk`, and
 * `fetchChunk` (whose `transform` is the baseline decoder). `readBack` controls
 * what storage returns: a `Uint32Array` (decoded bytes), `null` (sparse/empty →
 * zero-filled), or `"throw"` (read failure after retries).
 */
function fakeSource(
  readBack: Uint32Array | null | "throw" | "hang",
): FakeVolumeSource {
  const chunks = new Map<string, unknown>();
  return {
    spec: {
      rank: 3,
      chunkDataSize: [2, 2, 2],
      dataType: DataType.UINT32,
      compressedSegmentationBlockSize: undefined,
    },
    invalidateChunkCache: vi.fn(),
    deleteChunk: vi.fn((key: string) => chunks.delete(key)),
    chunks,
    fetchChunk: (_grid, transform) => {
      // "hang" models the real `fetchChunk`, whose chunk-arrival wait never
      // rejects on abort — so verification must bail on its own.
      if (readBack === "hang") return new Promise<ChunkVoxelBuffer>(() => {});
      if (readBack === "throw") return Promise.reject(new Error("read failed"));
      return Promise.resolve(transform({ data: readBack }));
    },
  };
}

/**
 * Build an `NgChunkSource` whose single `(LAYER, RES_8)` scale resolves to
 * `source`. Mirrors what `resolveVolumeChunkSource` walks: `getLayerByName →
 * layer.dataSources[].loadState → subsources[].subsourceEntry.subsource.volume`
 * plus the [8,8,8] model resolution from `modelTransform.outputSpace`.
 */
function makeChunkSourceResolving(source: FakeVolumeSource): NgChunkSource {
  const diag = new Float32Array(16);
  diag[0] = diag[5] = diag[10] = 1; // relativeScale 1 → 8nm
  const volume = {
    rank: 3,
    getSources: () => [
      [{ chunkSource: source, chunkToMultiscaleTransform: diag }],
    ],
  };
  const loadState = {
    subsources: [{ subsourceEntry: { subsource: { volume } } }],
    dataSource: {
      modelTransform: {
        outputSpace: { scales: [8e-9, 8e-9, 8e-9], units: ["m", "m", "m"] },
      },
    },
  };
  const userLayer = { dataSources: [{ loadState }] };
  const layerManager = {
    getLayerByName: (name: string) =>
      name === LAYER ? { layer: userLayer } : undefined,
  };
  return new NgChunkSource(
    layerManager as unknown as LayerManager,
    {} as unknown as ChunkManager,
  );
}

/** Minimal `SavedChunk` for `(LAYER, RES_8)` at chunk grid (0,0,0). */
function savedChunk(
  bytes: Uint32Array,
  layerId: LayerId = LAYER,
): SavedChunk {
  return {
    layerId,
    resolution: RES_8,
    chunkId: ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 }),
    chunkCoord: { x: 0, y: 0, z: 0 },
    contentRef: contentRefFromBuffer(bytes),
    bytes: { byteLength: bytes.byteLength, asView: () => bytes },
  } as unknown as SavedChunk;
}

describe("NgChunkSource.verifyChunksPersisted", () => {
  it("confirms a chunk whose read-back matches and invalidates only that chunk", async () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([savedChunk(SAVED)]);

    expect(result.ok).toBe(true);
    expect(result.unverified).toHaveLength(0);
    // Only the saved chunk's key is re-queued — no whole-source invalidation.
    expect(source.invalidateChunkCache).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("reports a mismatch as unverified", async () => {
    const source = fakeSource(Uint32Array.from([0, 0, 0, 0, 0, 0, 0, 99]));
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([savedChunk(SAVED)]);

    expect(result.ok).toBe(false);
    expect(result.unverified).toHaveLength(1);
  });

  it("treats a sparse/empty read-back as unverified", async () => {
    // The backend returned no object (zero-filled) but we saved non-zero data.
    const source = fakeSource(null);
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([savedChunk(SAVED)]);

    expect(result.ok).toBe(false);
    expect(result.unverified).toHaveLength(1);
  });

  it("treats an unreadable chunk as unverified", async () => {
    const source = fakeSource("throw");
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([savedChunk(SAVED)]);

    expect(result.ok).toBe(false);
    expect(result.unverified).toHaveLength(1);
  });

  it("drops a resident frontend chunk before reading back", async () => {
    const source = fakeSource(SAVED.slice());
    // Pre-seed the resident chunk at grid key "0,0,0" so the delete path runs.
    source.chunks.set("0,0,0", {});
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([savedChunk(SAVED)]);

    expect(result.ok).toBe(true);
    expect(source.deleteChunk).toHaveBeenCalledWith("0,0,0");
  });

  it("reports a chunk whose layer no longer resolves as unverified", async () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([
      savedChunk(SAVED, "gone" as LayerId),
    ]);

    expect(result.ok).toBe(false);
    expect(result.unverified).toHaveLength(1);
  });

  it("settles to unverified when aborted mid-read (never hangs)", async () => {
    // A read-back that never resolves must not hang the save: an aborted signal
    // bails it to unverified so `save()` always leaves the SAVING phase.
    const source = fakeSource("hang");
    const chunkSource = makeChunkSourceResolving(source);
    const controller = new AbortController();
    controller.abort();

    const result = await chunkSource.verifyChunksPersisted(
      [savedChunk(SAVED)],
      controller.signal,
    );

    expect(result.ok).toBe(false);
    expect(result.unverified).toHaveLength(1);
  });

  it("is a no-op for an empty chunk list", async () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    const result = await chunkSource.verifyChunksPersisted([]);

    expect(result.ok).toBe(true);
    expect(source.invalidateChunkCache).not.toHaveBeenCalled();
  });
});
