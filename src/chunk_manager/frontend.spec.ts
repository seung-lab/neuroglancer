/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  Chunk,
  ChunkQueueManager,
  ChunkSource,
} from "#src/chunk_manager/frontend.js";

const SOURCE_RPC_ID = 7;

/**
 * Bare frontend `ChunkSource` with the real prototype (`deleteChunk`,
 * `addChunk`, the `gl` getter chain) and just the fields `applyChunkUpdate`
 * touches.
 */
function makeSource(): ChunkSource {
  const source = Object.create(ChunkSource.prototype) as ChunkSource;
  Object.assign(source as unknown as Record<string, unknown>, {
    chunks: new Map<string, Chunk>(),
    chunkManager: { chunkQueueManager: { gl: {} } },
    rpcId: SOURCE_RPC_ID,
  });
  return source;
}

/**
 * Bare frontend `ChunkQueueManager` with the real `applyChunkUpdate` /
 * `processPendingChunkUpdates` prototype methods, resolving `SOURCE_RPC_ID`
 * to `source`.
 */
function makeQueueManager(source: ChunkSource): ChunkQueueManager {
  const qm = Object.create(ChunkQueueManager.prototype) as ChunkQueueManager;
  Object.assign(qm as unknown as Record<string, unknown>, {
    rpc: { get: (id: number) => (id === SOURCE_RPC_ID ? source : undefined) },
    gl: {},
    visibleChunksChanged: { dispatch: vi.fn() },
    chunkUpdateDeadline: null,
    pendingChunkUpdates: null,
    pendingChunkUpdatesTail: null,
  });
  return qm;
}

describe("ChunkQueueManager.applyChunkUpdate desync hardening (TM-375)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores a state-only update for a chunk it no longer holds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = makeSource();
    const qm = makeQueueManager(source);

    expect(() =>
      qm.applyChunkUpdate({
        source: SOURCE_RPC_ID,
        id: "0,0,0",
        state: ChunkState.SYSTEM_MEMORY,
      }),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    expect(source.chunks.size).toBe(0);
  });

  it("treats EXPIRED for an unknown chunk as a no-op", () => {
    const source = makeSource();
    const qm = makeQueueManager(source);

    expect(() =>
      qm.applyChunkUpdate({
        source: SOURCE_RPC_ID,
        id: "0,0,0",
        state: ChunkState.EXPIRED,
      }),
    ).not.toThrow();

    expect(source.chunks.size).toBe(0);
  });

  it("EXPIRED removes exactly the named chunk", () => {
    const source = makeSource();
    const qm = makeQueueManager(source);
    source.chunks.set("0,0,0", new Chunk(source));
    source.chunks.set("1,0,0", new Chunk(source));

    qm.applyChunkUpdate({
      source: SOURCE_RPC_ID,
      id: "0,0,0",
      state: ChunkState.EXPIRED,
    });

    expect([...source.chunks.keys()]).toEqual(["1,0,0"]);
  });

  it("a new-chunk update still fires pending fetchChunk requesters", () => {
    const source = makeSource();
    const qm = makeQueueManager(source);
    (source as unknown as { getChunk: (x: unknown) => Chunk }).getChunk = () =>
      new Chunk(source);
    const requester = vi.fn();
    source.chunkRequesters = new Map([["0,0,0", [requester]]]);

    qm.applyChunkUpdate({
      source: SOURCE_RPC_ID,
      id: "0,0,0",
      state: ChunkState.SYSTEM_MEMORY,
      new: true,
    });

    expect(requester).toHaveBeenCalledOnce();
    expect(source.chunks.has("0,0,0")).toBe(true);
  });
});

describe("ChunkQueueManager.processPendingChunkUpdates (TM-375)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps draining the queue when one update throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = makeSource();
    const qm = makeQueueManager(source);
    const applied: string[] = [];
    (
      qm as unknown as { applyChunkUpdate: (u: { tag: string }) => boolean }
    ).applyChunkUpdate = (u) => {
      if (u.tag === "bad") throw new Error("boom");
      applied.push(u.tag);
      return true;
    };
    const u3 = { tag: "c", nextUpdate: null };
    const u2 = { tag: "bad", nextUpdate: u3 };
    const u1 = { tag: "a", nextUpdate: u2 };
    qm.pendingChunkUpdates = u1;
    qm.pendingChunkUpdatesTail = u3;

    const numUpdates = qm.processPendingChunkUpdates(true);

    // All three updates were consumed; the bad one was logged and dropped
    // instead of stalling the queue (which is only rescheduled when it
    // transitions from empty).
    expect(numUpdates).toBe(3);
    expect(applied).toEqual(["a", "c"]);
    expect(error).toHaveBeenCalledOnce();
    expect(qm.pendingChunkUpdates).toBeNull();
    expect(qm.pendingChunkUpdatesTail).toBeNull();
  });
});
