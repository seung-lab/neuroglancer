/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ChunkVoxelBuffer, OverlayCoord } from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  ChunkReadAbortedError,
  ChunkReadFailedError,
} from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBaselineWithRetry } from "#src/editing/adapters/ng_chunk_source.js";
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
