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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChunkManager, ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { SimpleAsyncCacheOptions } from "#src/chunk_manager/generic_file_source.js";
import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";
import { RPC } from "#src/worker_rpc.js";

function makeCache(get: SimpleAsyncCacheOptions<string, string>["get"]) {
  const lifetime = new RefCounted();
  const rpc = new RPC({ onmessage: null, postMessage() {} }, false);
  const makeValue = <T>(value: T) =>
    lifetime.registerDisposer(SharedWatchableValue.make(rpc, value)).rpcId;
  const makeCapacity = () => ({
    itemLimit: makeValue(100),
    sizeLimit: makeValue(1e9),
  });
  const queueManager = lifetime.registerDisposer(
    new ChunkQueueManager(rpc, {
      id: rpc.newId(),
      gpuMemoryCapacity: makeCapacity(),
      systemMemoryCapacity: makeCapacity(),
      downloadCapacity: makeCapacity(),
      computeCapacity: makeCapacity(),
      enablePrefetch: makeValue(true),
    }),
  );
  const chunkManager = lifetime.registerDisposer(
    new ChunkManager(rpc, {
      id: rpc.newId(),
      chunkQueueManager: queueManager.rpcId,
    }),
  );
  const cache = new SimpleAsyncCache(chunkManager.addRef(), { get });
  return {
    cache,
    queueManager,
    [Symbol.dispose]() {
      for (const chunk of cache.chunks.values()) {
        if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
          chunk.freeSystemMemory();
        }
        queueManager.updateChunkState(chunk, ChunkState.QUEUED);
      }
      if (!cache.wasDisposed) cache.dispose();
      lifetime.dispose();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SimpleAsyncCache", () => {
  test("a failed network download is retried only by a new get, then success is cached", async () => {
    const error = new HttpError("https://example.com/index", 0, "network");
    const get = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: "result", size: 23 });
    using fixture = makeCache(get);
    const { cache, queueManager } = fixture;

    const first = cache.get("index", {});
    const concurrent = cache.get("index", {});
    await expect(first).rejects.toBe(error);
    await expect(concurrent).rejects.toBe(error);
    expect(cache.chunks.size).toBe(0);
    await vi.runAllTimersAsync();
    expect(get).toHaveBeenCalledTimes(1);

    const second = cache.get("index", {});
    const concurrentRetry = cache.get("index", {});
    await expect(second).resolves.toBe("result");
    await expect(concurrentRetry).resolves.toBe("result");
    const chunk = cache.chunks.get('"index"')!;
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunk.systemMemoryBytes).toBe(23);
    expect(queueManager.systemMemoryCapacity.currentItems).toBe(1);
    expect(queueManager.systemMemoryCapacity.currentSize).toBe(23);
    await expect(cache.get("index", {})).resolves.toBe("result");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test.each([
    new HttpError("url", 403, "forbidden"),
    new HttpError("url", 404, "not found"),
    new HttpError("url", 429, "too many requests"),
    new HttpError("url", 503, "unavailable"),
    new HttpError("url", 504, "timeout"),
    new TypeError("decode failed"),
    new Error("model failed"),
    new Error("decode failed", { cause: new HttpError("url", 0, "network") }),
  ])("preserves permanent cached errors: %s", async (error) => {
    const get = vi.fn().mockRejectedValue(error);
    using fixture = makeCache(get);
    await expect(fixture.cache.get("key", {})).rejects.toBe(error);
    await expect(fixture.cache.get("key", {})).rejects.toBe(error);
    expect(fixture.cache.chunks.get('"key"')!.state).toBe(ChunkState.FAILED);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("keeps the source alive until removing its last transient entry is complete", async () => {
    const download = Promise.withResolvers<{ data: string; size: number }>();
    using fixture = makeCache(() => download.promise);
    const { cache, queueManager } = fixture;
    const promise = cache.get("key", {});
    cache.dispose();
    const updateChunkState = queueManager.updateChunkState.bind(queueManager);
    vi.spyOn(queueManager, "updateChunkState").mockImplementation(
      (chunk, state) => {
        updateChunkState(chunk, state);
        expect(cache.wasDisposed).not.toBe(true);
      },
    );
    const error = new HttpError("url", 0, "network");
    download.reject(error);
    await expect(promise).rejects.toBe(error);
    expect(cache.chunks.size).toBe(0);
    expect(cache.wasDisposed).toBe(true);
    expect(queueManager.sources.has(cache)).toBe(false);
  });

  test.each(["resolve", "reject"] as const)(
    "ignores stale %s after the chunk is removed and reused",
    async (outcome) => {
      const download = Promise.withResolvers<{ data: string; size: number }>();
      const get = vi
        .fn()
        .mockImplementationOnce(() => download.promise)
        .mockResolvedValueOnce({ data: "new", size: 42 });
      using fixture = makeCache(get);
      const { cache, queueManager } = fixture;
      const oldPromise = cache.get("key", {});
      const oldChunk = cache.chunks.get('"key"')!;
      queueManager.updateChunkState(oldChunk, ChunkState.QUEUED);
      const newPromise = cache.get("key", {});
      expect(cache.chunks.get('"key"')).toBe(oldChunk);
      await expect(newPromise).resolves.toBe("new");

      if (outcome === "reject") {
        const error = new HttpError("url", 0, "network");
        download.reject(error);
        await expect(oldPromise).rejects.toBe(error);
      } else {
        download.resolve({ data: "old", size: 7 });
        await expect(oldPromise).resolves.toBe("old");
      }
      await expect(cache.get("key", {})).resolves.toBe("new");
      expect(oldChunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
      expect(oldChunk.systemMemoryBytes).toBe(42);
      expect(queueManager.systemMemoryCapacity.currentSize).toBe(42);
      expect(get).toHaveBeenCalledTimes(2);
    },
  );

  test("late network rejection of a cancelled generation cannot clear a newer success", async () => {
    const download = Promise.withResolvers<{ data: string; size: number }>();
    const get = vi
      .fn()
      .mockImplementationOnce(() => download.promise)
      .mockResolvedValueOnce({ data: "new", size: 42 });
    using fixture = makeCache(get);
    const { cache } = fixture;
    const controller = new AbortController();
    const oldPromise = cache.get("key", { signal: controller.signal });
    controller.abort();
    await expect(oldPromise).rejects.toBe(controller.signal.reason);
    await expect(cache.get("key", {})).resolves.toBe("new");
    download.reject(new HttpError("url", 0, "network"));
    await vi.runAllTimersAsync();
    await expect(cache.get("key", {})).resolves.toBe("new");
    expect(cache.chunks.get('"key"')!.state).toBe(
      ChunkState.SYSTEM_MEMORY_WORKER,
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("one cancelled consumer does not cancel a shared download", async () => {
    const download = Promise.withResolvers<{ data: string; size: number }>();
    const get = vi.fn<SimpleAsyncCacheOptions<string, string>["get"]>(
      () => download.promise,
    );
    using fixture = makeCache(get);
    const controller = new AbortController();
    const first = fixture.cache.get("key", { signal: controller.signal });
    const second = fixture.cache.get("key", {});
    controller.abort();
    await expect(first).rejects.toBe(controller.signal.reason);
    expect(get.mock.calls[0][1].signal.aborted).toBe(false);
    download.resolve({ data: "shared", size: 5 });
    await expect(second).resolves.toBe("shared");
    await expect(fixture.cache.get("key", {})).resolves.toBe("shared");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
