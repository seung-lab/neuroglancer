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

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ChunkManager as BackendManager,
  ChunkQueueManager as BackendQueue,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import {
  Chunk as FrontendChunk,
  type ChunkManager as FrontendManager,
  ChunkQueueManager as FrontendQueue,
} from "#src/chunk_manager/frontend.js";
import { InferenceVolumeChunkSource } from "#src/datasource/inference/backend.js";
import {
  getInferenceMetadataInfo,
  parseInferenceUrl,
} from "#src/datasource/inference/base.js";
import { publishLiveInference } from "#src/datasource/inference/frontend.js";
import type { LiveInference } from "#src/inference/live.js";
import { SLICEVIEW_REQUEST_CHUNK_RPC_ID } from "#src/sliceview/base.js";
import { SliceViewChunkSource } from "#src/sliceview/frontend.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import {
  DataType,
  makeVolumeChunkSpecification,
} from "#src/sliceview/volume/base.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";
import { RPC } from "#src/worker_rpc.js";

vi.hoisted(() => {
  // Importing the frontend needs shader enum constants, not a WebGL context.
  // The regular node project already supplies browser globals; this also allows
  // the fixture to run in a plain Node Vitest project without any GPU APIs.
  if (typeof WebGL2RenderingContext === "undefined") {
    vi.stubGlobal("WebGL2RenderingContext", {
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
    });
  }
});

const GRID = Float32Array.of(0, 0, 0);
const KEY = "0,0,0";
const NETWORK_URL = "https://example.invalid/input.shard";
const TWENTY_MINUTES = 20 * 60 * 1000;
const NATIVE_DATA = [3, 17, 129, 254];

interface RpcTarget {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: any, transfers?: Transferable[]): void;
}

interface Download {
  chunk: VolumeChunk;
  key: string;
  signal: AbortSignal;
  startedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

async function microtasks() {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

function networkError() {
  return new HttpError(NETWORK_URL, 0, "Network or CORS error", undefined, {
    cause: new TypeError("Failed to fetch"),
  });
}

function observe<T>(promise: Promise<T>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  return { promise, state: () => state };
}

function fixture(options: { immediateDownloadFailure?: () => unknown } = {}) {
  // Keep both simulated RPC realms in Node: Node structuredClone cannot model
  // a worker's typed-array/DOMException transport through jsdom's constructors.
  const traffic: { to: "backend" | "frontend"; data: any }[] = [];
  const delivered: { to: string; functionName: string; id: number }[] = [];
  const frontendTarget: RpcTarget = {
    onmessage: null,
    postMessage(data, transfers) {
      traffic.push({
        to: "backend",
        data: structuredClone(data, { transfer: transfers }),
      });
    },
  };
  const backendTarget: RpcTarget = {
    onmessage: null,
    postMessage(data, transfers) {
      traffic.push({
        to: "frontend",
        data: structuredClone(data, { transfer: transfers }),
      });
    },
  };
  const frontendRpc = new RPC(frontendTarget, false);
  const backendRpc = new RPC(backendTarget, false);
  // Both RPCs share the node realm. Give them disjoint ids as in separate
  // frontend/worker realms, without replacing the production RPC handlers.
  Reflect.set(frontendRpc, "nextId", 1000000);
  Reflect.set(backendRpc, "nextId", -1);

  async function deliver() {
    for (let n = 0; n < 1000; ++n) {
      await microtasks();
      const frame = traffic.shift();
      if (frame === undefined) return;
      delivered.push({
        to: frame.to,
        functionName: frame.data.functionName,
        id: frame.data.id,
      });
      const target = frame.to === "backend" ? backendTarget : frontendTarget;
      target.onmessage!({ data: frame.data } as MessageEvent);
    }
    throw new Error("RPC traffic did not quiesce");
  }

  let sharedId = 100;
  function value<T>(initial: T) {
    const id = ++sharedId;
    backendRpc.set(id, new WatchableValue(initial));
    return id;
  }
  function capacity(items: number) {
    return { itemLimit: value(items), sizeLimit: value(Infinity) };
  }
  const backendQueue = new BackendQueue(backendRpc, {
    id: 10,
    gpuMemoryCapacity: capacity(100),
    systemMemoryCapacity: capacity(100),
    downloadCapacity: capacity(2),
    computeCapacity: capacity(2),
    enablePrefetch: value(true),
  });
  const backendManager = new BackendManager(backendRpc, {
    id: 11,
    chunkQueueManager: 10,
  });
  // Only the GL-dependent constructor is omitted. Queueing, applying chunk
  // updates, and invoking frontend requesters are the production methods.
  const frontendQueue = Object.assign(Object.create(FrontendQueue.prototype), {
    rpc: frontendRpc,
    visibleChunksChanged: new NullarySignal(),
    pendingChunkUpdates: null,
    pendingChunkUpdatesTail: null,
    chunkUpdateDeadline: Date.now() - 1,
    chunkUpdateDelay: TWENTY_MINUTES * 3,
  }) as FrontendQueue;
  const frontendManager = Object.assign(new RefCounted(), {
    rpc: frontendRpc,
    rpcId: 11,
    chunkQueueManager: frontendQueue,
    prevStatisticsLayers: [],
    layerChunkStatisticsUpdated: new NullarySignal(),
  }) as unknown as FrontendManager;
  frontendRpc.set(11, frontendManager);

  class NativeBackend extends VolumeChunkSource {
    downloads: Download[] = [];

    download(chunk: VolumeChunk, signal: AbortSignal) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      this.downloads.push({
        chunk,
        key: chunk.key!,
        signal,
        startedAt: Date.now(),
        resolve: () => {
          chunk.data = Uint8Array.from(NATIVE_DATA);
          chunk.chunkDataSize = this.spec.chunkDataSize;
          resolve();
        },
        reject,
      });
      if (options.immediateDownloadFailure !== undefined) {
        reject(options.immediateDownloadFailure());
      }
      return promise;
    }
  }
  class NativeFrontend extends SliceViewChunkSource {
    getChunk(update: { data: Uint8Array }) {
      // Retain the real deserialized payload without constructing a GL format.
      return Object.assign(new FrontendChunk(this), { data: update.data });
    }
  }
  const spec = makeVolumeChunkSpecification({
    rank: 3,
    dataType: DataType.UINT8,
    chunkDataSize: Uint32Array.of(4, 1, 1),
    upperVoxelBound: Float32Array.of(8, 1, 1),
  });
  const source = new NativeBackend(backendRpc, {
    id: 12,
    chunkManager: 11,
    spec,
  });
  const frontendSource = new NativeFrontend(frontendManager, { spec });
  frontendSource.initializeSharedObject(frontendRpc, 12);
  frontendSource.referencedGeneration = 0;

  async function tick(ms = 10) {
    await vi.advanceTimersByTimeAsync(ms);
    await deliver();
  }

  function request(
    options: {
      retryTransientErrors?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const id = Reflect.get(frontendRpc, "nextId") as number;
    // Send the public wire flag through real promiseInvoke/getRef ownership.
    const result = observe(
      frontendRpc.promiseInvoke<void>(
        SLICEVIEW_REQUEST_CHUNK_RPC_ID,
        {
          source: frontendSource.addCounterpartRef(),
          chunkGridPosition: GRID,
          retryTransientErrors: options.retryTransientErrors,
        },
        { signal: options.signal },
      ),
    );
    return { ...result, id };
  }

  function fetch() {
    const id = Reflect.get(frontendRpc, "nextId") as number;
    const result = observe(
      frontendSource.fetchChunk(
        GRID,
        (chunk) =>
          Array.from((chunk as FrontendChunk & { data: Uint8Array }).data),
        {},
      ),
    );
    return { ...result, id };
  }

  function listenerCount() {
    const listeners = Reflect.get(source, "listeners_") as Map<
      string,
      unknown[]
    >;
    return [...listeners.values()].reduce((sum, list) => sum + list.length, 0);
  }
  function demandCount() {
    return (
      Reflect.get(
        backendManager.recomputeChunkPriorities,
        "handlers",
      ) as Set<unknown>
    ).size;
  }
  function expectRequestCleaned(id: number) {
    expect(frontendRpc.get(id)).toBeUndefined();
    expect(backendRpc.get(id)).toBeUndefined();
    expect(listenerCount()).toBe(0);
    expect(demandCount()).toBe(0);
  }

  return {
    frontendRpc,
    backendRpc,
    backendQueue,
    backendManager,
    frontendManager,
    frontendQueue,
    source,
    frontendSource,
    traffic,
    delivered,
    deliver,
    tick,
    request,
    fetch,
    listenerCount,
    demandCount,
    expectRequestCleaned,
  };
}

type Fixture = ReturnType<typeof fixture>;

async function beginRequest(
  h: Fixture,
  retryTransientErrors?: boolean,
  signal?: AbortSignal,
) {
  const request = h.request({ retryTransientErrors, signal });
  await h.deliver();
  await h.tick();
  return request;
}

async function failDownload(h: Fixture, error: unknown = networkError()) {
  const download = h.source.downloads.at(-1)!;
  expect(download.chunk.state).toBe(ChunkState.DOWNLOADING);
  const failedAt = Date.now();
  download.reject(error);
  await h.deliver();
  expect(download.chunk.state).toBe(ChunkState.FAILED);
  return failedAt;
}

async function retryAfter(h: Fixture, delay: number, failedAt: number) {
  const count = h.source.downloads.length;
  // Allow the scheduler's zero-delay work to run, but not the backoff timer.
  await h.tick(delay - 1);
  expect(h.source.downloads).toHaveLength(count);
  expect(h.source.chunks.get(KEY)!.state).toBe(ChunkState.FAILED);
  await h.tick(6);
  expect(h.source.downloads).toHaveLength(count + 1);
  const download = h.source.downloads.at(-1)!;
  expect(download.startedAt - failedAt).toBeGreaterThanOrEqual(delay);
  expect(download.startedAt - failedAt).toBeLessThanOrEqual(delay + 5);
  expect(download.key).toBe(KEY);
  expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Production jitter is .75 + random * .5, hence .5 means exact base delays.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

describe("sliceview input RPC transient download recovery", () => {
  it("recovers a cached failure that otherwise survives panning and twenty minutes", async () => {
    const h = fixture();
    const legacy = await beginRequest(h);
    const chunk = h.source.chunks.get(KEY)!;
    await failDownload(h);
    await expect(legacy.promise).rejects.toThrow("Network or CORS error");
    h.expectRequestCleaned(legacy.id);
    await h.tick(TWENTY_MINUTES);
    expect(chunk.state).toBe(ChunkState.FAILED);
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
    expect(h.source.downloads).toHaveLength(1);

    const retrying = await beginRequest(h, true);
    const backoffAt = Date.now() - 10;
    expect(retrying.state()).toBe("pending");
    expect(h.source.chunks.get(KEY)).toBe(chunk);
    expect(h.demandCount()).toBe(1);
    // beginRequest already advanced ten milliseconds of this cached backoff.
    await h.tick(489);
    expect(h.source.downloads).toHaveLength(1);
    await h.tick(6);
    expect(h.source.downloads).toHaveLength(2);
    expect(h.source.downloads[1].startedAt - backoffAt).toBeGreaterThanOrEqual(
      500,
    );
    expect(h.source.downloads[1].chunk).toBe(chunk);
    h.source.downloads[1].resolve();
    await h.deliver();
    await expect(retrying.promise).resolves.toBeUndefined();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    expect(h.frontendQueue.flushPendingChunkUpdates()).toBe(1);
    expect(h.frontendSource.chunks.has(KEY)).toBe(true);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
    h.expectRequestCleaned(retrying.id);
  });

  it("keeps the RPC and demand alive through 500/1000/2000ms retries, then publishes success", async () => {
    const h = fixture();
    const request = await beginRequest(h, true);
    const chunk = h.source.chunks.get(KEY)!;
    for (const delay of [500, 1000, 2000]) {
      const failedAt = await failDownload(h);
      expect(request.state()).toBe("pending");
      expect(h.backendRpc.get(request.id)).toBeDefined();
      expect(h.demandCount()).toBe(1);
      expect(h.listenerCount()).toBe(0);
      await retryAfter(h, delay, failedAt);
      expect(chunk.priorityTier).toBe(ChunkPriorityTier.VISIBLE);
      expect(chunk.priority).toBe(Infinity);
      expect(chunk.requestedState).toBe(ChunkState.SYSTEM_MEMORY);
      expect(request.state()).toBe("pending");
      expect(h.listenerCount()).toBe(1);
    }
    expect(h.source.downloads).toHaveLength(4);
    h.source.downloads[3].resolve();
    await h.deliver();
    await expect(request.promise).resolves.toBeUndefined();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    expect(Reflect.get(h.backendQueue, "numFailed")).toBe(0);
    h.expectRequestCleaned(request.id);
  });

  it("rejects visibly after exactly three retries and leaves no retry work behind", async () => {
    const h = fixture();
    const request = await beginRequest(h, true);
    for (const delay of [500, 1000, 2000]) {
      const failedAt = await failDownload(h);
      await retryAfter(h, delay, failedAt);
    }
    await failDownload(h);
    await expect(request.promise).rejects.toThrow(/failed after 3 retries/i);
    expect(h.source.downloads).toHaveLength(4);
    h.expectRequestCleaned(request.id);
    await h.tick(TWENTY_MINUTES);
    expect(h.source.downloads).toHaveLength(4);
    expect(h.source.chunks.get(KEY)!.state).toBe(ChunkState.FAILED);
  });

  it.each([
    ["403", () => new HttpError(NETWORK_URL, 403, "Forbidden")],
    ["404", () => new HttpError(NETWORK_URL, 404, "Not Found")],
    ["decode error", () => new Error("Invalid decoded chunk length")],
    ["bare TypeError", () => new TypeError("Decoder rejected chunk")],
  ] as const)("does not retry a permanent %s", async (_name, makeError) => {
    const h = fixture();
    const request = await beginRequest(h, true);
    const error = makeError();
    await failDownload(h, error);
    await expect(request.promise).rejects.toThrow(error.message);
    h.expectRequestCleaned(request.id);
    await h.tick(TWENTY_MINUTES);
    expect(h.source.downloads).toHaveLength(1);
  });

  it.each([undefined, false])(
    "preserves fail-fast behavior with retry flag %s",
    async (flag) => {
      const h = fixture();
      const request = await beginRequest(h, flag);
      await failDownload(h);
      await expect(request.promise).rejects.toThrow("Network or CORS error");
      h.expectRequestCleaned(request.id);
      await h.tick(TWENTY_MINUTES);
      expect(h.source.downloads).toHaveLength(1);
    },
  );

  it("cancels a backoff immediately, releases demand, and never requeues afterward", async () => {
    const h = fixture();
    const controller = new AbortController();
    const request = await beginRequest(h, true, controller.signal);
    await failDownload(h);
    await h.tick(100);
    expect(request.state()).toBe("pending");
    expect(h.demandCount()).toBe(1);
    controller.abort();
    // No advance to the retry deadline: cancellation must settle immediately.
    await h.deliver();
    await expect(request.promise).rejects.toHaveProperty("name", "AbortError");
    h.expectRequestCleaned(request.id);
    await h.tick(TWENTY_MINUTES);
    expect(h.source.downloads).toHaveLength(1);
    expect(h.source.chunks.get(KEY)!.state).toBe(ChunkState.FAILED);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
  });

  it("coalesces concurrent callers into one download for each retry", async () => {
    const h = fixture();
    const first = h.request({ retryTransientErrors: true });
    const second = h.request({ retryTransientErrors: true });
    await h.deliver();
    await h.tick();
    expect(h.source.downloads).toHaveLength(1);
    expect(h.listenerCount()).toBe(2);
    expect(h.demandCount()).toBe(2);
    const failedAt = await failDownload(h);
    await retryAfter(h, 500, failedAt);
    expect(h.listenerCount()).toBe(2);
    expect(h.source.downloads[1].signal.aborted).toBe(false);
    h.source.downloads[1].resolve();
    await h.deliver();
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(
      [undefined, undefined],
    );
    expect(h.source.downloads).toHaveLength(2);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
    h.expectRequestCleaned(first.id);
    h.expectRequestCleaned(second.id);
  });

  it("shares three actual retries across staggered concurrent callers with immediate failures", async () => {
    let randomCalls = 0;
    // The co-starting consumers initially wait 375ms and 625ms. Every retry
    // fails before the other consumer's old backoff expires, exposing a newer
    // failed generation even though the cached chunk object remains identical.
    vi.mocked(Math.random).mockImplementation(() => randomCalls++ % 2);
    const errors: HttpError[] = [];
    const h = fixture({
      immediateDownloadFailure: () => {
        const error = networkError();
        errors.push(error);
        return error;
      },
    });
    const first = h.request({ retryTransientErrors: true });
    const second = h.request({ retryTransientErrors: true });
    await h.deliver();
    await h.tick();
    expect(h.source.downloads).toHaveLength(1);
    expect(h.demandCount()).toBe(2);
    expect(
      vi
        .mocked(Math.random)
        .mock.results.slice(0, 2)
        .map((x) => x.value),
    ).toEqual([0, 1]);

    await h.tick(5000);
    expect(first.state()).toBe("rejected");
    expect(second.state()).toBe("rejected");
    await expect(first.promise).rejects.toThrow(/failed after 3 retries/i);
    await expect(second.promise).rejects.toThrow(/failed after 3 retries/i);
    h.expectRequestCleaned(first.id);
    h.expectRequestCleaned(second.id);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
    expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(0);
    expect(Reflect.get(h.backendQueue, "numQueued")).toBe(0);
    expect(Reflect.get(h.backendQueue, "numFailed")).toBe(1);
    expect(h.source.chunks.get(KEY)!.state).toBe(ChunkState.FAILED);
    expect(new Set(errors).size).toBe(errors.length);
    await h.tick(TWENTY_MINUTES);
    const firstStart = h.source.downloads[0].startedAt;
    const starts = h.source.downloads.map((x) => x.startedAt - firstStart);
    expect(
      h.source.downloads,
      `Native download starts (ms): ${JSON.stringify(starts)}`,
    ).toHaveLength(4);
  });

  it("one caller aborting its backoff does not cancel another caller's retry", async () => {
    const h = fixture();
    const controller = new AbortController();
    const canceled = h.request({
      retryTransientErrors: true,
      signal: controller.signal,
    });
    const survivor = h.request({ retryTransientErrors: true });
    await h.deliver();
    await h.tick();
    const failedAt = await failDownload(h);
    controller.abort();
    await h.deliver();
    await expect(canceled.promise).rejects.toHaveProperty("name", "AbortError");
    expect(h.demandCount()).toBe(1);
    await retryAfter(h, 500, failedAt);
    h.source.downloads[1].resolve();
    await h.deliver();
    await expect(survivor.promise).resolves.toBeUndefined();
    expect(h.source.downloads).toHaveLength(2);
    h.expectRequestCleaned(canceled.id);
    h.expectRequestCleaned(survivor.id);
  });

  it("does not requeue a download already restarted by another consumer", async () => {
    const h = fixture();
    const request = await beginRequest(h, true);
    await failDownload(h);
    await h.tick(100);
    // An explicit cache refresh simulates a second consumer recovering first.
    // It uses the real queue transition and starts a real scheduler download.
    h.backendQueue.invalidateSourceCache(h.source);
    await h.tick();
    expect(h.source.downloads).toHaveLength(2);
    const active = h.source.downloads[1];
    const controller = active.chunk.downloadAbortController;
    await h.tick(500);
    expect(h.source.downloads).toHaveLength(2);
    expect(active.chunk.state).toBe(ChunkState.DOWNLOADING);
    expect(active.chunk.downloadAbortController).toBe(controller);
    expect(active.signal.aborted).toBe(false);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(1);
    active.resolve();
    await h.deliver();
    await expect(request.promise).resolves.toBeUndefined();
    h.expectRequestCleaned(request.id);
  });

  it("does not mutate a stale captured chunk pooled for a different key during backoff", async () => {
    const h = fixture();
    const request = await beginRequest(h, true);
    await failDownload(h);
    await h.tick(100);
    const captured = h.source.chunks.get(KEY)!;
    expect(captured.systemMemoryRequested).toBe(true);
    // Recycling must also clear demand accumulated but not yet committed.
    captured.newSystemMemoryRequested = true;
    // Force eviction/replacement at the cache boundary while preserving queue
    // accounting. The retry must check both cache identity and current state;
    // the same object is now an unrelated FAILED chunk, not the requested key.
    h.backendQueue.updateChunkState(captured, ChunkState.NEW);
    h.source.removeChunk(captured);
    const other = h.source.getChunk(Float32Array.of(1, 0, 0));
    expect(other).toBe(captured);
    expect(other.systemMemoryRequested).toBe(false);
    expect(other.newSystemMemoryRequested).toBe(false);
    const otherError = networkError();
    other.error = otherError;
    h.backendQueue.updateChunkState(other, ChunkState.FAILED);
    await h.tick(500);
    expect(other.key).toBe("1,0,0");
    expect(other.state).toBe(ChunkState.FAILED);
    expect(other.error).toBe(otherError);
    expect(h.source.downloads).toHaveLength(2);
    const replacement = h.source.downloads[1];
    expect(replacement.key).toBe(KEY);
    expect(replacement.chunk).not.toBe(captured);
    replacement.resolve();
    await h.deliver();
    await expect(request.promise).resolves.toBeUndefined();
    h.expectRequestCleaned(request.id);
  });
});

// Fixed iteration counts keep a broken handoff from turning into a test timeout.
async function drainNativeHandoff(h: Fixture) {
  for (let pass = 0; pass < 4; ++pass) {
    await h.tick();
    h.frontendQueue.flushPendingChunkUpdates();
    await h.deliver();
  }
}

async function cacheNativeInWorker(h: Fixture, keepDemand = false) {
  let requestedState = ChunkState.SYSTEM_MEMORY_WORKER;
  const disposeDemand = h.backendManager.recomputeChunkPriorities.add(() => {
    h.backendManager.requestChunk(
      h.source.getChunk(GRID),
      ChunkPriorityTier.VISIBLE,
      Infinity,
      requestedState,
    );
  });
  h.backendManager.scheduleUpdateChunkPriorities();
  await h.tick();
  expect(h.source.downloads).toHaveLength(1);
  const download = h.source.downloads[0];
  download.resolve();
  await h.deliver();
  expect(download.chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
  if (!keepDemand) {
    disposeDemand();
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
  }
  return {
    chunk: download.chunk,
    disposeDemand,
    requestState(state: ChunkState) {
      requestedState = state;
      h.backendManager.scheduleUpdateChunkPriorities();
    },
  };
}

async function expectNativeHandoff(h: Fixture, chunk: VolumeChunk) {
  const data = chunk.data as Uint8Array;
  expect(Array.from(data)).toEqual(NATIVE_DATA);
  const buffer = data.buffer;
  const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
  const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
  const request = h.request();
  const consumer = h.fetch();
  await drainNativeHandoff(h);
  expect(request.state(), "native RPC must finish without GPU capacity").toBe(
    "resolved",
  );
  expect(consumer.state(), "frontend data consumer must finish").toBe(
    "resolved",
  );
  await expect(request.promise).resolves.toBeUndefined();
  await expect(consumer.promise).resolves.toEqual(NATIVE_DATA);
  expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
  expect(transfer).toHaveBeenCalledExactlyOnceWith(chunk);
  expect(gpuUpload).not.toHaveBeenCalled();
  expect(buffer.byteLength).toBe(0);
  expect(chunk.data).toBeNull();
  expect(h.source.downloads).toHaveLength(1);
  expect(h.frontendSource.chunks.get(KEY)!.state).toBe(
    ChunkState.SYSTEM_MEMORY,
  );
  expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(1);
  expect(h.backendQueue.systemMemoryCapacity.currentSize).toBe(
    NATIVE_DATA.length,
  );
  expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
  expect(h.backendQueue.gpuMemoryCapacity.currentItems).toBe(0);
  expect(h.backendQueue.gpuMemoryCapacity.currentSize).toBe(0);
  expect(h.frontendSource.chunkRequesters).toBeUndefined();
  h.expectRequestCleaned(request.id);
  h.expectRequestCleaned(consumer.id);
  await drainNativeHandoff(h);
  expect(transfer).toHaveBeenCalledTimes(1);
  expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
  expect(chunk.requestedState).toBe(ChunkState.NEW);
}

describe("native worker-to-frontend system memory handoff", () => {
  it("promotes a late download after its only requester aborts and is demoted", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const controller = new AbortController();
    const canceled = await beginRequest(h, undefined, controller.signal);
    const download = h.source.downloads[0];
    const { chunk } = download;
    expect(chunk.state).toBe(ChunkState.DOWNLOADING);
    expect(h.listenerCount()).toBe(1);
    controller.abort();
    await h.deliver();
    await h.tick();
    expect(canceled.state()).toBe("rejected");
    await expect(canceled.promise).rejects.toHaveProperty("name", "AbortError");
    h.expectRequestCleaned(canceled.id);
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
    expect(chunk.requestedState).toBe(ChunkState.NEW);
    // Ordinary native downloads intentionally survive removal of their requester.
    expect(download.signal.aborted).toBe(false);
    expect(chunk.state).toBe(ChunkState.DOWNLOADING);
    download.resolve();
    await h.deliver();
    await h.tick();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(h.frontendSource.chunks.size).toBe(0);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
    await expectNativeHandoff(h, chunk);
  });

  it("promotes an already worker-resident chunk once for concurrent native consumers", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const { chunk } = await cacheNativeInWorker(h);
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
    await expectNativeHandoff(h, chunk);
  });

  it.each(["cached", "cold", "inflight"] as const)(
    "completes a %s native read alongside GPU demand before GPU admission, then promotes without another transfer",
    async (phase) => {
      const h = fixture();
      h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
      const chunk =
        phase === "cached"
          ? (await cacheNativeInWorker(h)).chunk
          : (h.source.getChunk(GRID) as VolumeChunk);
      let data = chunk.data as Uint8Array | null;
      const serialize = vi.spyOn(chunk, "serialize");
      const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
      const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
      const disposeGpuDemand = h.backendManager.recomputeChunkPriorities.add(
        () => {
          h.backendManager.requestChunk(
            chunk,
            ChunkPriorityTier.VISIBLE,
            Infinity,
            ChunkState.GPU_MEMORY,
          );
        },
      );
      h.backendManager.scheduleUpdateChunkPriorities();
      if (phase !== "cold") {
        await drainNativeHandoff(h);
        expect(chunk.state).toBe(
          phase === "cached"
            ? ChunkState.SYSTEM_MEMORY_WORKER
            : ChunkState.DOWNLOADING,
        );
        expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
        expect(chunk.systemMemoryRequested).toBe(false);
        expect(transfer).not.toHaveBeenCalled();
      }
      const notifications: unknown[] = [];
      const listener = () => {
        if (chunk.state !== ChunkState.SYSTEM_MEMORY) return;
        notifications.push({
          transfers: transfer.mock.calls.length,
          workerData: chunk.data,
          workerBufferBytes: data!.buffer.byteLength,
        });
      };
      h.source.registerChunkListener(KEY, listener);

      // The native request must remain independently satisfiable even though
      // Math.min(GPU_MEMORY, SYSTEM_MEMORY) still aggregates to GPU_MEMORY.
      // Tier and priority also remain unchanged when this demand is added.
      const request = h.request();
      const consumer = h.fetch();
      await h.deliver();
      await h.tick();
      if (phase !== "cached") {
        expect(h.source.downloads).toHaveLength(1);
        expect(chunk.state).toBe(ChunkState.DOWNLOADING);
        expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
        expect(chunk.systemMemoryRequested).toBe(true);
        expect(chunk.newSystemMemoryRequested).toBe(false);
        h.source.downloads[0].resolve();
        data = chunk.data as Uint8Array;
      }
      await drainNativeHandoff(h);
      h.source.unregisterChunkListener(KEY, listener);
      expect(notifications).toEqual([
        { transfers: 1, workerData: null, workerBufferBytes: 0 },
      ]);
      expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
      expect(chunk.priorityTier).toBe(ChunkPriorityTier.VISIBLE);
      expect(chunk.priority).toBe(Infinity);
      expect(h.backendQueue.gpuMemoryCapacity.currentItems).toBe(0);
      expect(gpuUpload).not.toHaveBeenCalled();
      expect(h.source.downloads).toHaveLength(1);
      expect.soft(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
      expect(
        request.state(),
        "native RPC must finish despite concurrent GPU demand and zero GPU capacity",
      ).toBe("resolved");
      expect(consumer.state()).toBe("resolved");
      await expect(request.promise).resolves.toBeUndefined();
      await expect(consumer.promise).resolves.toEqual(NATIVE_DATA);
      expect(transfer).toHaveBeenCalledExactlyOnceWith(chunk);
      expect(data!.buffer.byteLength).toBe(0);
      expect(chunk.data).toBeNull();
      expect(h.frontendSource.chunks.get(KEY)!.state).toBe(
        ChunkState.SYSTEM_MEMORY,
      );
      expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(1);
      expect(h.backendQueue.systemMemoryCapacity.currentSize).toBe(
        NATIVE_DATA.length,
      );
      expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
      expect(h.frontendSource.chunkRequesters).toBeUndefined();
      expect(h.frontendRpc.get(request.id)).toBeUndefined();
      expect(h.backendRpc.get(request.id)).toBeUndefined();
      expect(h.frontendRpc.get(consumer.id)).toBeUndefined();
      expect(h.backendRpc.get(consumer.id)).toBeUndefined();
      expect(h.listenerCount()).toBe(0);
      expect(h.demandCount()).toBe(1); // Only the intentional GPU demand remains.

      h.backendQueue.gpuMemoryCapacity.itemLimit.value = 1;
      await drainNativeHandoff(h);
      expect(chunk.state).toBe(ChunkState.GPU_MEMORY);
      expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
      expect(h.frontendSource.chunks.get(KEY)!.state).toBe(
        ChunkState.GPU_MEMORY,
      );
      expect(gpuUpload).toHaveBeenCalledExactlyOnceWith(chunk);
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(serialize).toHaveBeenCalledTimes(1);
      expect(h.backendQueue.gpuMemoryCapacity.currentItems).toBe(1);
      expect(h.backendQueue.gpuMemoryCapacity.currentSize).toBe(
        NATIVE_DATA.length,
      );
      expect(h.source.downloads).toHaveLength(1);
      disposeGpuDemand();
      h.backendManager.scheduleUpdateChunkPriorities();
      await h.tick();
      h.expectRequestCleaned(request.id);
      h.expectRequestCleaned(consumer.id);
    },
  );

  it("leaves GPU-only demand worker-resident and untransferred when GPU capacity is zero", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const { chunk } = await cacheNativeInWorker(h);
    const data = chunk.data as Uint8Array;
    const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
    const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
    const disposeGpuDemand = h.backendManager.recomputeChunkPriorities.add(
      () => {
        h.backendManager.requestChunk(
          chunk,
          ChunkPriorityTier.VISIBLE,
          Infinity,
          ChunkState.GPU_MEMORY,
        );
      },
    );
    h.backendManager.scheduleUpdateChunkPriorities();
    await drainNativeHandoff(h);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.VISIBLE);
    expect(chunk.priority).toBe(Infinity);
    expect(transfer).not.toHaveBeenCalled();
    expect(gpuUpload).not.toHaveBeenCalled();
    expect(chunk.data).toBe(data);
    expect(Array.from(data)).toEqual(NATIVE_DATA);
    expect(data.buffer.byteLength).toBe(NATIVE_DATA.length);
    expect(h.frontendSource.chunks.size).toBe(0);
    expect(h.frontendSource.chunkRequesters).toBeUndefined();
    expect(h.source.downloads).toHaveLength(1);
    expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(1);
    expect(h.backendQueue.systemMemoryCapacity.currentSize).toBe(
      NATIVE_DATA.length,
    );
    expect(h.backendQueue.gpuMemoryCapacity.currentItems).toBe(0);
    expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
    expect(h.listenerCount()).toBe(0);
    expect(h.demandCount()).toBe(1);
    disposeGpuDemand();
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunk.requestedState).toBe(ChunkState.NEW);
    expect(transfer).not.toHaveBeenCalled();
    expect(h.demandCount()).toBe(0);
  });

  it("adds and removes only native demand at the same GPU state, tier, and priority", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const { chunk } = await cacheNativeInWorker(h);
    const data = chunk.data as Uint8Array;
    const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
    const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
    const tiers = [ChunkPriorityTier.VISIBLE, ChunkPriorityTier.PREFETCH];
    function updateDemand(native: boolean) {
      h.backendManager.requestChunk(
        chunk,
        ChunkPriorityTier.VISIBLE,
        Infinity,
        ChunkState.GPU_MEMORY,
      );
      if (native) {
        h.backendManager.requestChunk(
          chunk,
          ChunkPriorityTier.VISIBLE,
          Infinity,
          ChunkState.SYSTEM_MEMORY,
        );
      }
      h.backendManager.updateQueueState(tiers);
      expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
      expect(chunk.priorityTier).toBe(ChunkPriorityTier.VISIBLE);
      expect(chunk.priority).toBe(Infinity);
      expect(chunk.systemMemoryRequested).toBe(native);
      expect(chunk.newSystemMemoryRequested).toBe(false);
    }
    updateDemand(false);
    updateDemand(true); // Enqueue a frontend promotion without processing it.
    updateDemand(true); // Unchanged pass must consume/reset the pending flag.
    expect(chunk.newPriorityTier).toBe(ChunkPriorityTier.RECENT);
    expect(chunk.newPriority).toBe(-Infinity);
    expect(chunk.newRequestedState).toBe(ChunkState.NEW);
    updateDemand(false); // Remove only native demand before the queued handoff.
    await drainNativeHandoff(h);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunk.data).toBe(data);
    expect(data.buffer.byteLength).toBe(NATIVE_DATA.length);
    expect(transfer).not.toHaveBeenCalled();
    expect(h.frontendSource.chunks.size).toBe(0);
    updateDemand(true);
    await drainNativeHandoff(h);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    expect(transfer).toHaveBeenCalledExactlyOnceWith(chunk);
    expect(gpuUpload).not.toHaveBeenCalled();
    expect(data.buffer.byteLength).toBe(0);
    const consumer = h.fetch();
    await h.deliver();
    expect(consumer.state()).toBe("resolved");
    await expect(consumer.promise).resolves.toEqual(NATIVE_DATA);
    expect(h.source.downloads).toHaveLength(1);
    h.backendManager.updateQueueState(tiers);
    await h.tick();
    expect(chunk.systemMemoryRequested).toBe(false);
    expect(chunk.newSystemMemoryRequested).toBe(false);
    expect(chunk.requestedState).toBe(ChunkState.NEW);
    expect(h.demandCount()).toBe(0);
    expect(h.listenerCount()).toBe(0);
  });

  it("retains a surviving native consumer when another cancels a mixed GPU/native handoff", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const { chunk } = await cacheNativeInWorker(h);
    const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
    const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
    const disposeGpuDemand = h.backendManager.recomputeChunkPriorities.add(
      () => {
        h.backendManager.requestChunk(
          chunk,
          ChunkPriorityTier.VISIBLE,
          Infinity,
          ChunkState.GPU_MEMORY,
        );
      },
    );
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    const controller = new AbortController();
    const canceled = h.request({ signal: controller.signal });
    const survivor = h.fetch();
    await h.deliver();
    const tiers = [ChunkPriorityTier.VISIBLE, ChunkPriorityTier.PREFETCH];
    // Run real demand handlers, but stop before the scheduler process timer.
    h.backendManager.recomputeChunkPriorities.dispatch();
    h.backendManager.updateQueueState(tiers);
    expect(h.listenerCount()).toBe(2);
    expect(chunk.systemMemoryRequested).toBe(true);
    expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
    expect(transfer).not.toHaveBeenCalled();
    controller.abort();
    await h.deliver();
    expect(canceled.state()).toBe("rejected");
    await expect(canceled.promise).rejects.toHaveProperty("name", "AbortError");
    expect(h.listenerCount()).toBe(1);
    expect(h.demandCount()).toBe(2); // GPU demand and the surviving native RPC.
    h.backendManager.recomputeChunkPriorities.dispatch();
    h.backendManager.updateQueueState(tiers);
    expect(chunk.systemMemoryRequested).toBe(true);
    expect(chunk.newSystemMemoryRequested).toBe(false);
    expect(chunk.requestedState).toBe(ChunkState.GPU_MEMORY);
    await drainNativeHandoff(h);
    expect(survivor.state()).toBe("resolved");
    await expect(survivor.promise).resolves.toEqual(NATIVE_DATA);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    expect(transfer).toHaveBeenCalledExactlyOnceWith(chunk);
    expect(gpuUpload).not.toHaveBeenCalled();
    expect(h.source.downloads).toHaveLength(1);
    expect(chunk.systemMemoryRequested).toBe(false);
    expect(h.frontendSource.chunkRequesters).toBeUndefined();
    disposeGpuDemand();
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    h.expectRequestCleaned(canceled.id);
    h.expectRequestCleaned(survivor.id);
  });

  it("honors requested-state-only changes at the same tier and priority", async () => {
    const h = fixture();
    h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
    const { chunk, disposeDemand, requestState } = await cacheNativeInWorker(
      h,
      true,
    );
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.VISIBLE);
    expect(chunk.priority).toBe(Infinity);
    requestState(ChunkState.SYSTEM_MEMORY);
    const request = h.request();
    const consumer = h.fetch();
    await drainNativeHandoff(h);
    expect(chunk.requestedState).toBe(ChunkState.SYSTEM_MEMORY);
    expect(request.state()).toBe("resolved");
    expect(consumer.state()).toBe("resolved");
    await expect(consumer.promise).resolves.toEqual(NATIVE_DATA);
    expect(h.source.downloads).toHaveLength(1);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    disposeDemand();
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    h.expectRequestCleaned(request.id);
    h.expectRequestCleaned(consumer.id);
  });

  it("resets all pending accumulators on an unchanged pass rather than retaining old demand", async () => {
    const h = fixture();
    const { chunk, disposeDemand } = await cacheNativeInWorker(h, true);
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    expect
      .soft({
        tier: chunk.newPriorityTier,
        priority: chunk.newPriority,
        state: chunk.newRequestedState,
        systemMemoryRequested: chunk.newSystemMemoryRequested,
      })
      .toEqual({
        tier: ChunkPriorityTier.RECENT,
        priority: -Infinity,
        state: ChunkState.NEW,
        systemMemoryRequested: false,
      });
    disposeDemand();
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
    expect(chunk.requestedState).toBe(ChunkState.NEW);
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(h.demandCount()).toBe(0);
  });

  it.each(["demotion", "invalidation"] as const)(
    "removes a queued frontend promotion on normal %s before processing",
    async (kind) => {
      const h = fixture();
      h.backendQueue.gpuMemoryCapacity.itemLimit.value = 0;
      const { chunk } = await cacheNativeInWorker(h);
      const data = chunk.data as Uint8Array;
      const transfer = vi.spyOn(h.backendQueue, "moveChunkToFrontend");
      const gpuUpload = vi.spyOn(h.backendQueue, "copyChunkToGPU");
      const tiers = [ChunkPriorityTier.VISIBLE, ChunkPriorityTier.PREFETCH];
      // Apply real demand without running the scheduled process timer. This
      // leaves a worker-to-frontend promotion pending at the queue boundary.
      h.backendManager.requestChunk(
        chunk,
        ChunkPriorityTier.VISIBLE,
        Infinity,
        ChunkState.SYSTEM_MEMORY,
      );
      h.backendManager.updateQueueState(tiers);
      expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
      expect(chunk.requestedState).toBe(ChunkState.SYSTEM_MEMORY);
      expect(transfer).not.toHaveBeenCalled();
      if (kind === "demotion") {
        h.backendManager.updateQueueState(tiers);
      } else {
        h.backendQueue.downloadCapacity[0].itemLimit.value = 0;
        h.backendQueue.invalidateSourceCache(h.source);
      }
      await drainNativeHandoff(h);
      expect(transfer).not.toHaveBeenCalled();
      expect(gpuUpload).not.toHaveBeenCalled();
      expect(data.buffer.byteLength).toBe(NATIVE_DATA.length);
      expect(h.frontendSource.chunks.size).toBe(0);
      expect(h.source.downloads).toHaveLength(1);
      expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
      expect(h.backendQueue.gpuMemoryCapacity.currentItems).toBe(0);
      expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(
        kind === "demotion" ? 1 : 0,
      );
      expect(h.backendQueue.systemMemoryCapacity.currentSize).toBe(
        kind === "demotion" ? NATIVE_DATA.length : 0,
      );
      if (kind === "demotion") {
        expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
        expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
        expect(chunk.requestedState).toBe(ChunkState.NEW);
        expect(chunk.data).toBe(data);
      } else {
        expect(chunk.state).toBe(ChunkState.QUEUED);
        expect(chunk.data).toBeNull();
        // Finish the legitimate replacement download as well: removing the
        // stale handoff must not damage the download or memory queues.
        const request = h.request();
        const consumer = h.fetch();
        await h.deliver();
        h.backendQueue.downloadCapacity[0].itemLimit.value = 2;
        await h.tick();
        expect(h.source.downloads).toHaveLength(2);
        h.source.downloads[1].resolve();
        await drainNativeHandoff(h);
        expect(request.state()).toBe("resolved");
        expect(consumer.state()).toBe("resolved");
        await expect(consumer.promise).resolves.toEqual(NATIVE_DATA);
        expect(transfer).toHaveBeenCalledExactlyOnceWith(chunk);
        h.expectRequestCleaned(request.id);
        h.expectRequestCleaned(consumer.id);
        expect(h.frontendSource.chunkRequesters).toBeUndefined();
        expect(h.backendQueue.downloadCapacity[0].currentItems).toBe(0);
        expect(h.backendQueue.systemMemoryCapacity.currentItems).toBe(1);
        expect(h.backendQueue.systemMemoryCapacity.currentSize).toBe(
          NATIVE_DATA.length,
        );
      }
      expect(h.demandCount()).toBe(0);
      expect(h.listenerCount()).toBe(0);
    },
  );
});

async function liveFixture() {
  const h = fixture();
  const jobs: {
    signal: AbortSignal;
    resolve: (data: Float32Array) => void;
    reject: (error: unknown) => void;
  }[] = [];
  // A controlled tile provider, not a replacement for the RPC/queue methods.
  // Live/controller internals have their own tests and never run a GPU here.
  const live = {
    info: getInferenceMetadataInfo({
      channels: 1,
      shapeZYX: [16, 60, 120],
      originZYX: [0, 0, 0],
      spacingZYX: [1, 1, 1],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["nm", "nm", "nm"],
      provenance: {},
    }),
    readTile: vi.fn((_grid: readonly number[], signal: AbortSignal) => {
      const pending = Promise.withResolvers<Float32Array>();
      jobs.push({ signal, resolve: pending.resolve, reject: pending.reject });
      // Deliberately acknowledge cancellation late to expose stale replies.
      return pending.promise;
    }),
    dispose: vi.fn(),
  };
  const publishing = publishLiveInference(
    h.frontendManager,
    live as unknown as LiveInference,
  );
  await h.deliver();
  const publication = await publishing;
  const source = new InferenceVolumeChunkSource(h.backendRpc, {
    id: 13,
    chunkManager: 11,
    parameters: { resultId: parseInferenceUrl(publication.url) },
    spec: makeVolumeChunkSpecification({
      rank: 4,
      dataType: DataType.FLOAT32,
      chunkDataSize: Uint32Array.of(60, 60, 16, 1),
      upperVoxelBound: Float32Array.of(120, 60, 16, 1),
    }),
  });
  let wanted = false;
  h.backendManager.recomputeChunkPriorities.add(() => {
    if (!wanted) return;
    const chunk = source.getChunk(Float32Array.of(0, 0, 0, 0));
    h.backendManager.requestChunk(
      chunk,
      ChunkPriorityTier.VISIBLE,
      0,
      ChunkState.SYSTEM_MEMORY_WORKER,
    );
  });
  async function demand(value: boolean) {
    wanted = value;
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
  }
  return { ...h, inferenceSource: source, jobs, publication, demand };
}

describe("real RPC and scheduler cancellation ordering controls", () => {
  it("does not lose a deferred frontend callback after RPC completion, abort, and eviction", async () => {
    const h = fixture();
    h.backendQueue.systemMemoryCapacity.itemLimit.value = 1;
    const controller = new AbortController();
    const reason = new DOMException("Panned away", "AbortError");
    let callbacks = 0;
    const request = observe(
      h.frontendSource.fetchChunk(
        GRID,
        () => {
          ++callbacks;
          // Inference input callbacks encode exceptions as values.
          try {
            controller.signal.throwIfAborted();
            return { ok: true };
          } catch (error) {
            return { ok: false, error };
          }
        },
        { signal: controller.signal },
      ),
    );
    await h.deliver();
    await h.tick();
    h.source.downloads[0].resolve();
    await h.deliver();
    const responses = h.delivered
      .filter((m) => m.to === "frontend")
      .map((m) => m.functionName);
    expect(responses.indexOf("Chunk.update")).toBeGreaterThanOrEqual(0);
    expect(responses.indexOf("Chunk.update")).toBeLessThan(
      responses.indexOf("rpc.promise.response"),
    );
    expect(request.state()).toBe("pending");
    controller.abort(reason);
    await h.deliver();
    expect(
      h.delivered.some((m) => m.functionName === "rpc.promise.cancel"),
    ).toBe(false);
    const replacement = h.source.getChunk(Float32Array.of(1, 0, 0));
    h.backendManager.recomputeChunkPriorities.add(() => {
      h.backendManager.requestChunk(
        replacement,
        ChunkPriorityTier.VISIBLE,
        0,
        ChunkState.SYSTEM_MEMORY,
      );
    });
    h.backendManager.scheduleUpdateChunkPriorities();
    await h.tick();
    expect(h.source.chunks.has(KEY)).toBe(false);
    expect(h.frontendQueue.pendingChunkUpdatesTail.state).toBe(
      ChunkState.EXPIRED,
    );
    expect(callbacks).toBe(0);
    expect(h.frontendQueue.flushPendingChunkUpdates()).toBe(2);
    await expect(request.promise).resolves.toEqual({
      ok: false,
      error: reason,
    });
    expect(callbacks).toBe(1);
    expect(h.frontendSource.chunks.size).toBe(0);
    expect(h.frontendSource.chunkRequesters).toBeUndefined();
  });

  it.each(["AbortError", "TypeError", "success"])(
    "ignores stale %s after live demotion and pooled chunk reuse",
    async (kind) => {
      const h = await liveFixture();
      await h.demand(true);
      const first = h.inferenceSource.chunks.get("0,0,0,0")!;
      const controller = first.downloadAbortController!;
      expect(h.jobs).toHaveLength(1);
      await h.demand(false);
      expect(controller.signal.aborted).toBe(true);
      expect(h.jobs[0].signal.aborted).toBe(true);
      expect(h.inferenceSource.chunks.size).toBe(0);
      expect(h.backendQueue.downloadCapacity[1].currentItems).toBe(0);
      expect(Reflect.get(h.backendQueue, "numQueued")).toBe(0);
      await h.demand(true);
      const fresh = h.inferenceSource.chunks.get("0,0,0,0")!;
      expect(fresh).toBe(first);
      expect(fresh.downloadAbortController).not.toBe(controller);
      if (kind === "success") h.jobs[0].resolve(new Float32Array(16 * 60 * 60));
      else
        h.jobs[0].reject(
          kind === "AbortError"
            ? new DOMException("Old job cancelled", "AbortError")
            : new TypeError("Failed to fetch"),
        );
      await h.deliver();
      expect(fresh.state).toBe(ChunkState.DOWNLOADING);
      expect(fresh.error).toBeNull();
      expect(console.log).not.toHaveBeenCalled();
      expect(h.backendQueue.downloadCapacity[1].currentItems).toBe(1);
      h.jobs[1].resolve(new Float32Array(16 * 60 * 60).fill(7));
      await h.deliver();
      expect(fresh.state, String(fresh.error)).toBe(
        ChunkState.SYSTEM_MEMORY_WORKER,
      );
      expect(((fresh as VolumeChunk).data as Float32Array)[0]).toBe(7);
      expect(h.backendQueue.downloadCapacity[1].currentItems).toBe(0);
      expect(Reflect.get(h.backendQueue, "numFailed")).toBe(0);
      h.publication.dispose();
      await h.deliver();
    },
  );

  it("ignores an already queued error reply when demotion is processed first", async () => {
    const h = await liveFixture();
    await h.demand(true);
    const old = h.inferenceSource.chunks.get("0,0,0,0")!;
    h.jobs[0].reject(new TypeError("Failed to fetch"));
    await microtasks();
    expect(h.traffic.some((m) => m.to === "backend" && m.data.error)).toBe(
      true,
    );
    // The real late-hook timer runs before delivery of the queued RPC reply.
    await h.demand(false);
    expect(h.inferenceSource.chunks.size).toBe(0);
    expect(old.source).toBeNull();
    expect(console.log).not.toHaveBeenCalled();
    expect(Reflect.get(h.backendQueue, "numFailed")).toBe(0);
    h.publication.dispose();
    await h.deliver();
  });

  it.each(["AbortError", "TypeError"])(
    "keeps an active output %s failure cached rather than retrying all inference failures",
    async (kind) => {
      const h = await liveFixture();
      await h.demand(true);
      const chunk = h.inferenceSource.chunks.get("0,0,0,0")!;
      expect(h.jobs[0].signal.aborted).toBe(false);
      h.jobs[0].reject(
        kind === "AbortError"
          ? new DOMException("Remote cancellation", "AbortError")
          : new TypeError("Failed to fetch"),
      );
      await h.deliver();
      expect(chunk.state).toBe(ChunkState.FAILED);
      expect(chunk.error.name, String(chunk.error)).toBe(kind);
      await h.demand(false);
      expect(chunk.priorityTier).toBe(ChunkPriorityTier.RECENT);
      await h.demand(true);
      expect(h.inferenceSource.chunks.get("0,0,0,0")).toBe(chunk);
      await h.tick(TWENTY_MINUTES);
      expect(chunk.state).toBe(ChunkState.FAILED);
      expect(h.jobs).toHaveLength(1);
      h.backendQueue.invalidateSourceCache(h.inferenceSource);
      // This fixture has no frontend volume source for the output publication.
      h.traffic.length = 0;
      await h.tick();
      expect(h.jobs).toHaveLength(2);
      h.jobs[1].resolve(new Float32Array(16 * 60 * 60));
      await h.deliver();
      expect(chunk.state, String(chunk.error)).toBe(
        ChunkState.SYSTEM_MEMORY_WORKER,
      );
      expect(Reflect.get(h.backendQueue, "numFailed")).toBe(0);
      h.publication.dispose();
      await h.deliver();
    },
  );
});
