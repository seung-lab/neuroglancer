// @vitest-environment node

/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test, vi } from "vitest";
import {
  CHUNK_SOURCE_INVALIDATE_RPC_ID,
  ChunkState,
} from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import { RPC } from "#src/worker_rpc.js";

const SOURCE_RPC_ID = 42;

function makeSource() {
  const postMessage = vi.fn();
  // Invalidation does not access the chunk manager or require a GL context.
  const source = new ChunkSource({} as ChunkManager);
  source.rpc = new RPC({ onmessage: null, postMessage }, false);
  source.rpcId = SOURCE_RPC_ID;
  return {
    source,
    postMessage,
    [Symbol.dispose]() {
      if (!source.wasDisposed) source.dispose();
    },
  };
}

describe("Chunk.update", () => {
  test.each([
    { source: SOURCE_RPC_ID },
    {
      source: SOURCE_RPC_ID,
      id: "0,0,0",
      state: ChunkState.SYSTEM_MEMORY,
      new: true,
    },
  ])("ignores late updates after source removal: %j", (update) => {
    using fixture = makeSource();
    const rpc = fixture.source.rpc!;
    rpc.set(SOURCE_RPC_ID, fixture.source);
    fixture.source.dispose();
    rpc.delete(SOURCE_RPC_ID);

    expect(() =>
      rpc.target.onmessage!({
        data: { functionName: "Chunk.update", ...update },
      } as MessageEvent),
    ).not.toThrow();
    expect(fixture.postMessage).not.toHaveBeenCalled();
  });

  test("still queues updates for a live source in order", () => {
    using fixture = makeSource();
    const rpc = fixture.source.rpc!;
    const queueManager = {
      pendingChunkUpdates: null,
      pendingChunkUpdatesTail: null,
      scheduleChunkUpdate: vi.fn(),
    };
    Object.assign(fixture.source.chunkManager, {
      chunkQueueManager: queueManager,
    });
    rpc.set(SOURCE_RPC_ID, fixture.source);
    const first = { functionName: "Chunk.update", source: SOURCE_RPC_ID };
    const second = {
      functionName: "Chunk.update",
      source: SOURCE_RPC_ID,
      id: "0,0,0",
      state: ChunkState.SYSTEM_MEMORY,
      new: true,
    };

    rpc.target.onmessage!({ data: first } as MessageEvent);
    rpc.target.onmessage!({ data: second } as MessageEvent);

    expect(queueManager.pendingChunkUpdates).toBe(first);
    expect(queueManager.pendingChunkUpdatesTail).toBe(second);
    expect(first).toHaveProperty("nextUpdate", second);
    expect(queueManager.scheduleChunkUpdate).toHaveBeenCalledExactlyOnceWith();
  });
});

describe("ChunkSource.invalidateCache", () => {
  test("posts the RPC before exactly one synchronous notification per invalidation", () => {
    using fixture = makeSource();
    const { source, postMessage } = fixture;
    const chunk = new Chunk(source);
    source.addChunk("cached", chunk);
    const observer = vi.fn(() => {
      expect(postMessage).toHaveBeenLastCalledWith(
        { functionName: CHUNK_SOURCE_INVALIDATE_RPC_ID, id: SOURCE_RPC_ID },
        undefined,
      );
      expect(postMessage).toHaveBeenCalledTimes(observer.mock.calls.length);
      // Notification does not wait for the worker's asynchronous cache eviction.
      expect(source.chunks.get("cached")).toBe(chunk);
    });
    source.cacheInvalidated.add(observer);
    expect(source.cacheInvalidated.count).toBe(0);
    expect(observer).not.toHaveBeenCalled();

    for (let count = 1; count <= 2; ++count) {
      source.invalidateCache();
      expect(postMessage).toHaveBeenCalledTimes(count);
      expect(observer).toHaveBeenCalledTimes(count);
      expect(observer).toHaveBeenLastCalledWith();
      expect(source.cacheInvalidated.count).toBe(count);
    }
  });

  test("allows an observer to dispose the source and clear its RPC", () => {
    using fixture = makeSource();
    const { source, postMessage } = fixture;
    const observer = vi.fn(() => {
      source.dispose();
      source.rpc = null;
      source.rpcId = null;
    });
    source.cacheInvalidated.add(observer);

    expect(() => source.invalidateCache()).not.toThrow();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { functionName: CHUNK_SOURCE_INVALIDATE_RPC_ID, id: SOURCE_RPC_ID },
      undefined,
    );
    expect(observer).toHaveBeenCalledExactlyOnceWith();
    expect(source.wasDisposed).toBe(true);
    expect(source.rpc).toBeNull();
    expect(source.rpcId).toBeNull();
  });

  test("notifies once on RPC failure and propagates the original error", () => {
    using fixture = makeSource();
    const { source, postMessage } = fixture;
    const error = new Error("RPC post failed");
    postMessage.mockImplementationOnce(() => {
      throw error;
    });
    const observer = vi.fn();
    source.cacheInvalidated.add(observer);

    let thrown: unknown;
    try {
      source.invalidateCache();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(error);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { functionName: CHUNK_SOURCE_INVALIDATE_RPC_ID, id: SOURCE_RPC_ID },
      undefined,
    );
    expect(observer).toHaveBeenCalledExactlyOnceWith();
    expect(source.cacheInvalidated.count).toBe(1);
  });
});
