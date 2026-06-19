/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, OverlayCoord, Resolution } from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { SessionChunkPreloader } from "#src/editing/adapters/session_chunk_preloader.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";

interface PermCall {
  readonly key: string;
  readonly permanent: boolean;
}

interface FakeSource {
  readonly source: VolumeChunkSource;
  readonly perm: PermCall[];
}

/**
 * Minimal fake `VolumeChunkSource` exercising only what the preloader touches:
 * `spec.rank`, `chunkManager.markChunkPermanent`, and `fetchChunk`.
 * `fetchKey(key)` decides whether a given chunk's fetch resolves or rejects.
 */
function makeFakeSource(
  fetchKey: (key: string) => Promise<void>,
  rank = 3,
): FakeSource {
  const perm: PermCall[] = [];
  const chunkManager = {
    markChunkPermanent(_s: unknown, key: string, permanent: boolean): void {
      perm.push({ key, permanent });
    },
  };
  const source = {
    spec: { rank },
    chunkManager,
    async fetchChunk(
      grid: Float32Array,
      transform: (chunk: unknown) => void,
    ): Promise<void> {
      const key = grid.join();
      await fetchKey(key);
      transform(undefined);
    },
  };
  return { source: source as unknown as VolumeChunkSource, perm };
}

function coord(x: number, y: number, z: number): OverlayCoord {
  return {
    layerId: "seg" as LayerId,
    resolution: "8x8x8" as Resolution,
    chunkId: ChunkIdFactory.fromCoord({ x, y, z }),
  };
}

describe("SessionChunkPreloader", () => {
  it("loads every chunk, pins each once, and ends in done with no failures", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source);
    const coords = [coord(0, 0, 0), coord(1, 0, 0), coord(2, 0, 0)];

    await preloader.start(coords, new AbortController().signal);

    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 3,
      failed: 0,
      failures: [],
    });
    const pins = fake.perm.filter((c) => c.permanent);
    expect(pins).toHaveLength(3);
    expect(new Set(pins.map((c) => c.key)).size).toBe(3);
  });

  it("treats a fetch rejection as a valid zero baseline (loaded, not failed)", async () => {
    const fake = makeFakeSource((key) =>
      key === "1,0,0" ? Promise.reject(new Error("404")) : Promise.resolve(),
    );
    const preloader = new SessionChunkPreloader(() => fake.source);
    const coords = [coord(0, 0, 0), coord(1, 0, 0), coord(2, 0, 0)];

    await preloader.start(coords, new AbortController().signal);

    // Still completes; the 404 chunk is counted as loaded, not a failure.
    expect(preloader.progress.value).toEqual({
      kind: "done",
      total: 3,
      failed: 0,
      failures: [],
    });
    // Only the two resolved chunks get pinned.
    expect(fake.perm.filter((c) => c.permanent)).toHaveLength(2);
  });

  it("records a source-resolution failure without aborting the rest", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader((layerId) => {
      if (layerId === ("missing" as LayerId)) {
        throw new Error("layer-not-found");
      }
      return fake.source;
    });
    const good = coord(0, 0, 0);
    const bad: OverlayCoord = {
      layerId: "missing" as LayerId,
      resolution: "8x8x8" as Resolution,
      chunkId: ChunkIdFactory.fromCoord({ x: 9, y: 9, z: 9 }),
    };

    await preloader.start([good, bad], new AbortController().signal);

    const state = preloader.progress.value;
    expect(state.kind).toBe("done");
    if (state.kind !== "done") throw new Error("unreachable");
    expect(state.failed).toBe(1);
    expect(state.failures).toEqual([
      { layerId: "missing", resolution: "8x8x8", count: 1 },
    ]);
    // The good layer still loaded + pinned.
    expect(fake.perm.filter((c) => c.permanent)).toHaveLength(1);
  });

  it("release() unmarks every pinned chunk exactly once and is idempotent", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source);
    await preloader.start(
      [coord(0, 0, 0), coord(1, 0, 0)],
      new AbortController().signal,
    );

    preloader.release();
    const unpins = fake.perm.filter((c) => !c.permanent);
    expect(unpins).toHaveLength(2);
    expect(preloader.progress.value).toEqual({ kind: "idle" });

    // Second release is a no-op.
    preloader.release();
    expect(fake.perm.filter((c) => !c.permanent)).toHaveLength(2);
  });

  it("does not transition to done when aborted before starting", async () => {
    const fake = makeFakeSource(() => Promise.resolve());
    const preloader = new SessionChunkPreloader(() => fake.source);
    const controller = new AbortController();
    controller.abort();

    await preloader.start([coord(0, 0, 0), coord(1, 0, 0)], controller.signal);

    // Aborted before any fetch launched: never reaches "done", nothing pinned.
    expect(preloader.progress.value.kind).not.toBe("done");
    expect(fake.perm.filter((c) => c.permanent)).toHaveLength(0);
  });
});
