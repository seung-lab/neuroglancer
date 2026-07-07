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

import type { Chunk, ChunkSource } from "#src/chunk_manager/backend.js";
import { ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";

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
