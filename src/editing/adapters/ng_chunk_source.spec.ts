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
  ReadonlyChunkVoxelBuffer,
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

/**
 * Fake `VolumeChunkSource` for the edge-chunk padding path (TM-353): `spec`
 * carries the NOMINAL `chunkDataSize`; `fetchChunk` hands the transform a chunk
 * with the given `data` and (optionally) an edge-clipped `chunkDataSize`,
 * mimicking how NG exposes a boundary chunk's actual extent on
 * `VolumeChunk.chunkDataSize`.
 */
function makeEdgeSource(
  data: ArrayBufferView | null,
  opts: { chunkDataSize: number[]; clipped?: number[] },
): VolumeChunkSource {
  const source = {
    spec: {
      rank: 3,
      chunkDataSize: opts.chunkDataSize,
      dataType: DataType.UINT8,
      compressedSegmentationBlockSize: undefined,
    },
    async fetchChunk(
      _grid: Float32Array,
      transform: (chunk: unknown) => ChunkVoxelBuffer,
    ): Promise<ChunkVoxelBuffer> {
      const chunk =
        opts.clipped === undefined
          ? { data }
          : { data, chunkDataSize: Uint32Array.from(opts.clipped) };
      return transform(chunk);
    },
  };
  return source as unknown as VolumeChunkSource;
}

describe("decodeBaselineChunk edge-chunk padding (TM-353)", () => {
  it("pads a boundary chunk (data smaller than nominal) into the low corner", async () => {
    // NG decodes this 4x4 chunk clipped to its 2x2 data extent; the library
    // indexes slots with the nominal 4x4 stride, so the baseline must be the
    // full 16-voxel nominal buffer with the 2x2 data in the corner and zeros
    // elsewhere — otherwise the nominal-stride write/fuse overruns the 4-voxel
    // clipped buffer.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([
      1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("leaves an interior chunk (already nominal) unchanged", async () => {
    const full = Uint8Array.from([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const source = makeEdgeSource(full, {
      chunkDataSize: [4, 4, 1],
      clipped: [4, 4, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual(Array.from(full));
  });

  it("pads a z-clipped chunk into the first slice", async () => {
    // Nominal 2x2x2, data clipped to the first z-slice (2x2x1) → four voxels in
    // slice 0, the second slice zero.
    const source = makeEdgeSource(Uint8Array.from([1, 2, 3, 4]), {
      chunkDataSize: [2, 2, 2],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    expect(Array.from(result.asView() as Uint8Array)).toEqual([
      1, 2, 3, 4, 0, 0, 0, 0,
    ]);
  });

  it("zero-fills a sparse (null-data) edge chunk at the nominal size", async () => {
    const source = makeEdgeSource(null, {
      chunkDataSize: [4, 4, 1],
      clipped: [2, 2, 1],
    });

    const result = await fetchBaselineWithRetry(source, COORD, GRID, undefined);

    const view = result.asView() as Uint8Array;
    expect(view.length).toBe(16);
    expect(Array.from(view).every((v) => v === 0)).toBe(true);
  });
});

const LAYER = "seg" as LayerId;
const RES_8 = ResolutionCtor.from([8, 8, 8]);
const CHUNK_ID = ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 });
const CHUNK_COORD = { x: 0, y: 0, z: 0 };
// 2x2x2 UINT32 chunk → eight voxels (matches the fake source's chunkDataSize).
const SAVED = Uint32Array.from([10, 11, 12, 13, 14, 15, 16, 17]);

function buffer(bytes: Uint32Array): ReadonlyChunkVoxelBuffer {
  return { byteLength: bytes.byteLength, asView: () => bytes };
}

interface FakeVolumeSource {
  spec: {
    rank: number;
    chunkDataSize: number[];
    dataType: DataType;
    compressedSegmentationBlockSize: undefined;
  };
  fetchFreshDecodedChunk: (
    grid: Float32Array,
    signal: AbortSignal,
  ) => Promise<{
    data: ArrayBufferView | null;
    chunkDataSize: Uint32Array | null;
  }>;
  fetchChunk?: (
    grid: Float32Array,
    transform: (chunk: { data: ArrayBufferView | null }) => ChunkVoxelBuffer,
  ) => Promise<ChunkVoxelBuffer>;
  invalidateChunkCache: ReturnType<typeof vi.fn>;
}

/**
 * Fake `VolumeChunkSource` exercising what the read-back verification touches:
 * `spec` (for resolution resolution + `decodeBaselineChunk`) and the
 * non-evicting `fetchFreshDecodedChunk`. `readBack` controls what storage
 * returns: a `Uint32Array` (decoded bytes), `null` (sparse/empty → zero-filled),
 * or `"throw"` (read failure → caller retries).
 */
function fakeSource(
  readBack: Uint32Array | null | "throw",
  datasource?: Uint32Array | null,
): FakeVolumeSource {
  return {
    spec: {
      rank: 3,
      chunkDataSize: [2, 2, 2],
      dataType: DataType.UINT32,
      compressedSegmentationBlockSize: undefined,
    },
    fetchFreshDecodedChunk: () => {
      if (readBack === "throw") return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        data: readBack,
        chunkDataSize: Uint32Array.from([2, 2, 2]),
      });
    },
    // The datasource render-base read path (`readDatasourceBaseline` →
    // `fetchBaselineWithRetry` → `source.fetchChunk`). Only wired when a
    // `datasource` buffer is supplied.
    fetchChunk:
      datasource === undefined
        ? undefined
        : (_grid, transform) =>
            Promise.resolve(transform({ data: datasource })),
    invalidateChunkCache: vi.fn(),
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

describe("NgChunkSource saved-baseline (re-entry)", () => {
  it("readBaselineChunk returns the client-retained saved bytes", async () => {
    // The fake source has no `fetchChunk`, so a fall-through to the datasource
    // would throw — returning SAVED proves the saved-baseline short-circuit.
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    const result = await chunkSource.readBaselineChunk(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );

    expect(Array.from(result.asView() as Uint32Array)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it("records the content hash of the saved bytes", () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    expect(chunkSource.getSavedBaselineHash(LAYER, RES_8, CHUNK_ID)).toBe(
      contentRefFromBuffer(SAVED).hash,
    );
  });
});

describe("NgChunkSource.readDatasourceBaseline (render base)", () => {
  it("reads the datasource render base, ignoring the saved edit baseline", async () => {
    // The render composites the GPU patch over the datasource chunk, so the
    // PatchMirror mask must diff against THIS, not the saved bytes — otherwise
    // just-saved voxels drop out of the mask and revert on screen (TM-352).
    const DATASOURCE = Uint32Array.from([1, 1, 1, 1, 1, 1, 1, 1]);
    const source = fakeSource(SAVED.slice(), DATASOURCE.slice());
    const chunkSource = makeChunkSourceResolving(source);
    // Record DIFFERENT saved bytes; readDatasourceBaseline must NOT return them.
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    const datasource = await chunkSource.readDatasourceBaseline(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );
    const editBaseline = await chunkSource.readBaselineChunk(
      LAYER,
      RES_8,
      CHUNK_ID,
      CHUNK_COORD,
    );

    // readDatasourceBaseline → the datasource render base (all 1s).
    expect(Array.from(datasource.asView() as Uint32Array)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    // readBaselineChunk → still the saved edit baseline (proves they diverge).
    expect(Array.from(editBaseline.asView() as Uint32Array)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });
});

describe("NgChunkSource.confirmChunkPersisted (read-back verify)", () => {
  it("confirms when the fresh read-back matches the saved hash", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_ID,
        CHUNK_COORD,
      ),
    ).toBe(true);
  });

  it("rejects a value mismatch", async () => {
    const chunkSource = makeChunkSourceResolving(
      fakeSource(Uint32Array.from([0, 0, 0, 0, 0, 0, 0, 99])),
    );
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_ID,
        CHUNK_COORD,
      ),
    ).toBe(false);
  });

  it("rejects a sparse/empty read-back (saved non-zero data)", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(null));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_ID,
        CHUNK_COORD,
      ),
    ).toBe(false);
  });

  it("propagates a read error so the caller can retry", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource("throw"));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));

    await expect(
      chunkSource.confirmChunkPersisted(LAYER, RES_8, CHUNK_ID, CHUNK_COORD),
    ).rejects.toThrow();
  });

  it("is false when nothing was recorded as saved", async () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));

    expect(
      await chunkSource.confirmChunkPersisted(
        LAYER,
        RES_8,
        CHUNK_ID,
        CHUNK_COORD,
      ),
    ).toBe(false);
  });
});

describe("NgChunkSource exit reconciliation (TM-352)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clearSavedBaseline drops the retained saved bytes", () => {
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));
    expect(chunkSource.getSavedBaselineHash(LAYER, RES_8, CHUNK_ID)).toBe(
      contentRefFromBuffer(SAVED).hash,
    );

    chunkSource.clearSavedBaseline();

    expect(
      chunkSource.getSavedBaselineHash(LAYER, RES_8, CHUNK_ID),
    ).toBeUndefined();
    expect(chunkSource.getSavedBytes(LAYER, RES_8, CHUNK_ID)).toBeUndefined();
  });

  it("invalidateDatasourceChunks evicts the saved chunk's datasource cache key", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    chunkSource.invalidateDatasourceChunks([
      { layerId: LAYER, resolution: RES_8, chunkCoord: CHUNK_COORD },
    ]);

    // makeChunkGridPosition({0,0,0}).join() === "0,0,0".
    expect(source.invalidateChunkCache).toHaveBeenCalledTimes(1);
    expect(source.invalidateChunkCache).toHaveBeenCalledWith(["0,0,0"]);
  });

  it("batches multiple chunks of one source into a single eviction call", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    chunkSource.invalidateDatasourceChunks([
      { layerId: LAYER, resolution: RES_8, chunkCoord: { x: 0, y: 0, z: 0 } },
      { layerId: LAYER, resolution: RES_8, chunkCoord: { x: 1, y: 2, z: 3 } },
    ]);

    expect(source.invalidateChunkCache).toHaveBeenCalledTimes(1);
    expect(source.invalidateChunkCache).toHaveBeenCalledWith([
      "0,0,0",
      "1,2,3",
    ]);
  });

  it("skips chunks whose layer no longer resolves to a source", () => {
    const source = fakeSource(SAVED.slice());
    const chunkSource = makeChunkSourceResolving(source);

    expect(() =>
      chunkSource.invalidateDatasourceChunks([
        {
          layerId: "gone" as LayerId,
          resolution: RES_8,
          chunkCoord: CHUNK_COORD,
        },
      ]),
    ).not.toThrow();
    expect(source.invalidateChunkCache).not.toHaveBeenCalled();
  });

  it("after clear, readBaselineChunk no longer short-circuits to the saved bytes", async () => {
    // The fake source has no `fetchChunk`, so once the saved short-circuit is
    // gone the baseline read falls through to the datasource and fails — proving
    // the cleared cache no longer shadows the backend on re-entry.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunkSource = makeChunkSourceResolving(fakeSource(SAVED.slice()));
    chunkSource.recordSavedBaseline(LAYER, RES_8, CHUNK_ID, buffer(SAVED));
    chunkSource.clearSavedBaseline();

    await expect(
      chunkSource.readBaselineChunk(LAYER, RES_8, CHUNK_ID, CHUNK_COORD),
    ).rejects.toBeInstanceOf(ChunkReadFailedError);
  });
});
