/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";

import type { ChunkSource } from "#src/chunk_manager/backend.js";
import { Chunk, ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";

interface SentMessage {
  readonly name: string;
  readonly args: { id?: string; state?: ChunkState; source?: number };
}

/**
 * Bare `ChunkQueueManager` exercising only the invalidation path: the REAL
 * `invalidateChunkCache` / `evictAndRequeueChunk` / `freeChunkGPUMemory` /
 * `freeChunkSystemMemory` prototype methods over a recording RPC stub, with
 * the queue bookkeeping (`updateChunkState`, `scheduleUpdate`) replaced by
 * spies — the full queue machinery needs a live RPC counterpart and is out of
 * scope here.
 */
function makeQueueManager() {
  const sent: SentMessage[] = [];
  const qm = Object.create(ChunkQueueManager.prototype) as ChunkQueueManager;
  const updateChunkState = vi.fn();
  const scheduleUpdate = vi.fn();
  Object.assign(qm as unknown as Record<string, unknown>, {
    rpc: {
      invoke: (name: string, args: SentMessage["args"]) => {
        sent.push({ name, args });
      },
    },
    gpuMemoryGeneration: 0,
    updateChunkState,
    scheduleUpdate,
  });
  return { qm, sent, updateChunkState, scheduleUpdate };
}

function makeSource(rpcId: number): ChunkSource {
  return { rpcId, chunks: new Map<string, Chunk>() } as unknown as ChunkSource;
}

function addChunk(source: ChunkSource, key: string, state: ChunkState): Chunk {
  const chunk = {
    key,
    state,
    source,
    freeSystemMemory: vi.fn(),
  } as unknown as Chunk;
  source.chunks.set(key, chunk);
  return chunk;
}

describe("ChunkQueueManager.invalidateChunkCache (TM-375)", () => {
  it("evicts only the named chunks, via per-chunk frontend updates", () => {
    const { qm, sent, updateChunkState, scheduleUpdate } = makeQueueManager();
    const source = makeSource(7);
    const gpuChunk = addChunk(source, "0,0,0", ChunkState.GPU_MEMORY);
    const memChunk = addChunk(source, "1,0,0", ChunkState.SYSTEM_MEMORY);
    const untouched = addChunk(source, "2,0,0", ChunkState.GPU_MEMORY);

    qm.invalidateChunkCache(source, ["0,0,0", "1,0,0"]);

    // A GPU-resident chunk is stepped down (GPU → system memory → expired);
    // a system-memory chunk is expired directly. The untouched chunk gets no
    // message at all.
    expect(sent).toEqual([
      {
        name: "Chunk.update",
        args: { id: "0,0,0", state: ChunkState.SYSTEM_MEMORY, source: 7 },
      },
      {
        name: "Chunk.update",
        args: { id: "0,0,0", state: ChunkState.EXPIRED, source: 7 },
      },
      {
        name: "Chunk.update",
        args: { id: "1,0,0", state: ChunkState.EXPIRED, source: 7 },
      },
    ]);
    // Every message names its chunk: the id-less source-wide form would wipe
    // EVERY frontend chunk of the source while the backend still counts the
    // non-invalidated ones as frontend-resident (the TM-375 desync).
    expect(sent.every((m) => m.args.id !== undefined)).toBe(true);
    expect(updateChunkState).toHaveBeenCalledWith(gpuChunk, ChunkState.QUEUED);
    expect(updateChunkState).toHaveBeenCalledWith(memChunk, ChunkState.QUEUED);
    expect(updateChunkState).not.toHaveBeenCalledWith(
      untouched,
      expect.anything(),
    );
    expect(scheduleUpdate).toHaveBeenCalled();
  });

  it("frees a worker-resident chunk without any frontend message", () => {
    const { qm, sent, updateChunkState } = makeQueueManager();
    const source = makeSource(7);
    const chunk = addChunk(source, "0,0,0", ChunkState.SYSTEM_MEMORY_WORKER);

    qm.invalidateChunkCache(source, ["0,0,0"]);

    expect(
      (chunk as unknown as { freeSystemMemory: ReturnType<typeof vi.fn> })
        .freeSystemMemory,
    ).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(updateChunkState).toHaveBeenCalledWith(chunk, ChunkState.QUEUED);
  });

  it("cancels an in-flight download and requeues it", () => {
    const { qm, sent, updateChunkState } = makeQueueManager();
    const source = makeSource(7);
    const chunk = addChunk(source, "0,0,0", ChunkState.DOWNLOADING);
    const controller = new AbortController();
    (
      chunk as unknown as { downloadAbortController?: AbortController }
    ).downloadAbortController = controller;

    qm.invalidateChunkCache(source, ["0,0,0"]);

    expect(controller.signal.aborted).toBe(true);
    expect(sent).toEqual([]);
    expect(updateChunkState).toHaveBeenCalledWith(chunk, ChunkState.QUEUED);
  });

  it("skips unknown keys entirely", () => {
    const { qm, sent, updateChunkState, scheduleUpdate } = makeQueueManager();
    const source = makeSource(7);
    addChunk(source, "0,0,0", ChunkState.GPU_MEMORY);

    qm.invalidateChunkCache(source, ["9,9,9"]);

    expect(sent).toEqual([]);
    expect(updateChunkState).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });
});

/**
 * Surgical harness for `performChunkPriorityUpdate`: the REAL prototype method
 * and the REAL `Chunk.updatePriorityProperties`, with the queue-membership
 * helpers replaced by spies (queue re-derivation itself needs the full
 * pairing-heap machinery and is out of scope).
 */
function makePriorityHarness() {
  const qm = Object.create(ChunkQueueManager.prototype) as ChunkQueueManager;
  const removeChunkFromQueues_ = vi.fn();
  const addChunkToQueues_ = vi.fn();
  const adjustCapacitiesForChunk = vi.fn();
  Object.assign(qm as unknown as Record<string, unknown>, {
    removeChunkFromQueues_,
    addChunkToQueues_,
    adjustCapacitiesForChunk,
  });
  return { qm, removeChunkFromQueues_, addChunkToQueues_ };
}

function makePriorityChunk(fields: Partial<Chunk>): Chunk {
  const chunk = Object.create(Chunk.prototype) as Chunk;
  // Mirrors `Chunk.initialize` field-by-field; `initialize` itself is not
  // usable here because the `state` setter notifies `source.chunkStateChanged`,
  // which needs the full source machinery.
  Object.assign(chunk as unknown as Record<string, unknown>, {
    key: "0,0,0",
    source: { chunkStateChanged: () => {} },
    priority: Number.NEGATIVE_INFINITY,
    priorityTier: ChunkPriorityTier.RECENT,
    newPriority: Number.NEGATIVE_INFINITY,
    newPriorityTier: ChunkPriorityTier.RECENT,
    error: null,
    state_: ChunkState.NEW,
    requestedState: ChunkState.NEW,
    newRequestedState: ChunkState.NEW,
    permanent: false,
  });
  Object.assign(chunk, fields);
  return chunk;
}

describe("ChunkQueueManager.performChunkPriorityUpdate", () => {
  it("applies a residency upgrade even when tier and priority are unchanged", () => {
    // Regression: a chunk first requested by the fetch RPC at
    // (VISIBLE, +Infinity, SYSTEM_MEMORY) — e.g. a brush baseline read of a
    // chunk the renderer had not yet promoted — then re-requested at the SAME
    // tier/priority with GPU_MEMORY residency (permanent pin + render layer).
    // The early return keyed only on (tier, priority) never applied the
    // upgrade, so the chunk could never enter the GPU promotion queue and its
    // paint overlay stayed invisible for the rest of the session.
    const { qm, addChunkToQueues_ } = makePriorityHarness();
    const chunk = makePriorityChunk({
      state: ChunkState.SYSTEM_MEMORY,
      priorityTier: ChunkPriorityTier.VISIBLE,
      priority: Number.POSITIVE_INFINITY,
      requestedState: ChunkState.SYSTEM_MEMORY,
      newPriorityTier: ChunkPriorityTier.VISIBLE,
      newPriority: Number.POSITIVE_INFINITY,
      newRequestedState: ChunkState.GPU_MEMORY,
    });

    qm.performChunkPriorityUpdate(chunk);

    expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
    // Queues must be re-derived so `chunkQueuesForChunk` can now yield the
    // GPU promotion queue for this SYSTEM_MEMORY chunk.
    expect(addChunkToQueues_).toHaveBeenCalledOnce();
  });

  it("early-returns without queue churn when nothing changed, resetting accumulators", () => {
    const { qm, removeChunkFromQueues_, addChunkToQueues_ } =
      makePriorityHarness();
    const chunk = makePriorityChunk({
      state: ChunkState.SYSTEM_MEMORY,
      priorityTier: ChunkPriorityTier.VISIBLE,
      priority: 5,
      requestedState: ChunkState.GPU_MEMORY,
      newPriorityTier: ChunkPriorityTier.VISIBLE,
      newPriority: 5,
      newRequestedState: ChunkState.GPU_MEMORY,
    });

    qm.performChunkPriorityUpdate(chunk);

    expect(removeChunkFromQueues_).not.toHaveBeenCalled();
    expect(addChunkToQueues_).not.toHaveBeenCalled();
    expect(chunk.newPriorityTier).toBe(ChunkPriorityTier.RECENT);
    expect(chunk.newPriority).toBe(Number.NEGATIVE_INFINITY);
    // The accumulator must reset on this path too, or a stale min() survives
    // into the next recompute cycle.
    expect(chunk.newRequestedState).toBe(ChunkState.NEW);
  });
});
