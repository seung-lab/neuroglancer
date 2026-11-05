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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WatershedMeshSource } from "#src/datasource/watershed/backend.js";
import {
  WATERSHED_MESH_RPC_ID,
  type WatershedMeshSnapshot,
  type WatershedMeshState,
} from "#src/datasource/watershed/base.js";
import {
  assignMeshFragmentData,
  FragmentChunk,
  ManifestChunk,
} from "#src/mesh/backend.js";
import { watershedMeshComputation } from "#src/watershed/mesh_request.js";

vi.mock("#src/async_computation/request.js", () => ({
  requestAsyncComputation: vi.fn(),
}));
vi.mock(import("#src/mesh/backend.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  assignMeshFragmentData: vi.fn(),
}));

const compute = vi.mocked(requestAsyncComputation);
const assign = vi.mocked(assignMeshFragmentData);

type Mesh = { vertexPositions: Float32Array; indices: Uint32Array };
type Reply = WatershedMeshState | WatershedMeshSnapshot | undefined;
interface MeshRequest {
  chunkManager: number;
  resultId: string;
  meshKey: string;
  generation: number;
  objectId: bigint;
  snapshot: boolean;
  error?: string;
}

const cleanup: (() => void)[] = [];
const downloads: Promise<unknown>[] = [];

function track<T>(promise: Promise<T>): Promise<T> {
  // Attach a rejection handler immediately, including for downloads queued
  // behind another job. Keep the original promise for rejection assertions.
  downloads.push(promise);
  void promise.catch(() => {});
  return promise;
}

function deferred<T>(cleanupValue: T) {
  const gate = Promise.withResolvers<T>();
  cleanup.push(() => gate.resolve(cleanupValue));
  return gate;
}

function makeMesh(): Mesh {
  return {
    vertexPositions: Float32Array.of(0, 0, 0, 1.25, 0.5, -0.25, -0.5, 2, 3),
    indices: Uint32Array.of(0, 1, 2),
  };
}

function deferNative() {
  const gate = deferred(makeMesh());
  const started = Promise.withResolvers<void>();
  compute.mockImplementationOnce(() => {
    started.resolve();
    // Deliberately ignore abort: a dispatched synchronous WASM extraction
    // physically retains its memory until the worker finally responds.
    return gate.promise;
  });
  return { ...gate, started: started.promise };
}

async function microtasks() {
  // Drain ready promise continuations for negative assertions, never a timer.
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

function fixture() {
  const state = { value: { epoch: 3, generation: 7 } };
  const snapshot: WatershedMeshSnapshot = {
    ...state.value,
    shapeXYZ: [3, 2, 2],
    lowerXYZ: [11, 22, 33],
    labels: Uint32Array.of(
      0,
      17,
      9,
      17,
      1,
      0xffffffff,
      9,
      0,
      17,
      0xffffffff,
      17,
      9,
    ),
  };
  const parameters = { resultId: "deadbeef", meshKey: "selected-final-ids" };
  const promiseInvoke = vi.fn(
    async (
      _method: string,
      request: MeshRequest,
      _options: { signal: AbortSignal },
    ): Promise<Reply> => {
      if (request.error !== undefined) return undefined;
      return request.snapshot ? { ...snapshot, ...state.value } : state.value;
    },
  );
  // Skip RPC construction only. Both download methods, request(), and the
  // module-global extraction queue remain the actual backend implementation.
  const source = Object.assign(Object.create(WatershedMeshSource.prototype), {
    state,
    parameters,
    rpc: { promiseInvoke },
    chunkManager: { rpcId: 123 },
  }) as WatershedMeshSource;

  function manifest(objectId = 17n) {
    const chunk = new ManifestChunk();
    chunk.objectId = objectId;
    chunk.fragmentIds = null;
    return chunk;
  }

  function fragment(generation = state.value.generation, objectId = 17n) {
    const chunk = new FragmentChunk();
    chunk.manifestChunk = manifest(objectId);
    chunk.fragmentId = String(generation);
    return chunk;
  }

  return {
    source,
    state,
    snapshot,
    parameters,
    promiseInvoke,
    manifest,
    fragment,
  };
}

beforeEach(() => {
  compute.mockReset();
  compute.mockImplementation(() => {
    throw new Error(
      "Unexpected native computation: configure a deferred response",
    );
  });
  assign.mockReset();
});

afterEach(async () => {
  // Even a failed assertion must release physical jobs and drain the real
  // global queue before the next test; do not reset or replace that queue.
  for (const resolve of cleanup.splice(0)) resolve();
  await Promise.allSettled(downloads.splice(0));
});

describe("WatershedMeshSource manifests", () => {
  it("requests readiness for the selected object and returns a generation fragment", async () => {
    const h = fixture();
    const chunk = h.manifest(0xffffffffn);
    const { signal } = new AbortController();
    await track(h.source.download(chunk, signal));
    expect(chunk.fragmentIds).toEqual(["7"]);
    expect(h.promiseInvoke).toHaveBeenCalledExactlyOnceWith(
      WATERSHED_MESH_RPC_ID,
      {
        chunkManager: 123,
        ...h.parameters,
        generation: 7,
        objectId: 0xffffffffn,
        snapshot: false,
        error: undefined,
      },
      { signal },
    );
    expect(compute).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("returns an ordinary empty manifest while pending, then downloads normally after invalidation", async () => {
    const h = fixture();
    const chunk = h.manifest();
    const { signal } = new AbortController();
    h.promiseInvoke.mockResolvedValueOnce(undefined);
    await track(h.source.download(chunk, signal));
    expect(chunk.fragmentIds).toEqual([]);
    expect(compute).not.toHaveBeenCalled();

    // Frontend readiness invalidates the cache and advances shared generation.
    // Re-download the same chunk as the scheduler would, without a new source.
    h.state.value = { epoch: 4, generation: 8 };
    await track(h.source.download(chunk, signal));
    expect(chunk.fragmentIds).toEqual(["8"]);
    expect(
      h.promiseInvoke.mock.calls.map(([, request]) => request.generation),
    ).toEqual([7, 8]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not publish a manifest reply from an older generation", async () => {
    const h = fixture();
    const reply = deferred<Reply>(h.state.value);
    h.promiseInvoke.mockReturnValueOnce(reply.promise);
    const chunk = h.manifest();
    const pending = track(
      h.source.download(chunk, new AbortController().signal),
    );
    const previous = h.state.value;
    h.state.value = { ...previous, generation: previous.generation + 1 };
    reply.resolve(previous);
    await pending;
    expect(chunk.fragmentIds).toEqual([]);
    expect(compute).not.toHaveBeenCalled();
  });

  it("does not publish a manifest after aborting its pending RPC", async () => {
    const h = fixture();
    const reply = deferred<Reply>(h.state.value);
    h.promiseInvoke.mockReturnValueOnce(reply.promise);
    const chunk = h.manifest();
    const controller = new AbortController();
    const pending = track(h.source.download(chunk, controller.signal));
    controller.abort(
      new DOMException("Manifest no longer needed", "AbortError"),
    );
    reply.resolve(h.state.value);
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(chunk.fragmentIds).toBeNull();
    expect(h.promiseInvoke).toHaveBeenCalledOnce();
  });
});

describe("WatershedMeshSource fragments", () => {
  it.each([
    [17n, [0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 255, 0]],
    [9n, [0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255]],
    [0xffffffffn, [0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0]],
  ] as const)(
    "extracts only final ID %s into an owned 0/255 mask and translates only by local lower",
    async (objectId, expectedMask) => {
      const h = fixture();
      const native = deferNative();
      const chunk = h.fragment(7, objectId);
      const { signal } = new AbortController();
      const labelsBefore = new Uint32Array(h.snapshot.labels);
      const pending = track(h.source.downloadFragment(chunk, signal));
      await native.started;

      expect(h.promiseInvoke).toHaveBeenCalledExactlyOnceWith(
        WATERSHED_MESH_RPC_ID,
        {
          chunkManager: 123,
          ...h.parameters,
          generation: 7,
          objectId,
          snapshot: true,
          error: undefined,
        },
        { signal },
      );
      expect(compute).toHaveBeenCalledOnce();
      const [spec, workerSignal, transfers, mask, shape] =
        compute.mock.calls[0];
      expect(spec).toBe(watershedMeshComputation);
      expect(workerSignal).toBe(signal);
      expect(shape).toEqual(h.snapshot.shapeXYZ);
      expect(mask).toBeInstanceOf(Uint8Array);
      expect(Array.from(mask)).toEqual(expectedMask);
      expect(mask.byteOffset).toBe(0);
      expect(mask.buffer.byteLength).toBe(h.snapshot.labels.length);
      expect(mask.buffer).not.toBe(h.snapshot.labels.buffer);
      expect(transfers).toEqual([mask.buffer]);
      // Exercise actual transfer semantics, not just the transfer-list shape.
      const workerMask = structuredClone(mask, { transfer: transfers });
      expect(mask.byteLength).toBe(0);
      expect(Array.from(workerMask)).toEqual(expectedMask);
      expect(h.snapshot.labels).toEqual(labelsBefore);
      expect(assign).not.toHaveBeenCalled();

      const mesh = makeMesh();
      native.resolve(mesh);
      await pending;
      expect(assign).toHaveBeenCalledExactlyOnceWith(chunk, mesh);
      expect(assign.mock.calls[0][1]).toBe(mesh);
      // In particular: no +0.5 voxel-center shift, source origin, or spacing.
      expect(Array.from(mesh.vertexPositions)).toEqual([
        11, 22, 33, 12.25, 22.5, 32.75, 10.5, 24, 36,
      ]);
      expect(mesh.indices).toEqual(Uint32Array.of(0, 1, 2));
      expect(h.snapshot.labels).toEqual(labelsBefore);
    },
  );

  it("rejects placement that would lose float32 vertex precision and reports the current error", async () => {
    const h = fixture();
    const snapshot = { ...h.snapshot, lowerXYZ: [2 ** 24, 22, 33] };
    h.promiseInvoke.mockResolvedValueOnce(snapshot);
    const native = deferNative();
    const chunk = h.fragment();
    const { signal } = new AbortController();
    const pending = track(h.source.downloadFragment(chunk, signal));
    await native.started;
    expect(assign).not.toHaveBeenCalled();
    // Both local X values are exact float32s. Adding this volume-local lower
    // must not silently round them to 16777216 and 16777218 in the mesh buffer.
    native.resolve({
      vertexPositions: Float32Array.of(1, 0, 0, 1.5, 1, 0, 2, 0, 1),
      indices: Uint32Array.of(0, 1, 2),
    });
    await expect(pending).rejects.toThrow(/float32.*precision/i);
    const failure = await pending.catch((error: unknown) => error);
    expect(signal.aborted).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(h.promiseInvoke).toHaveBeenCalledTimes(2);
    expect(h.promiseInvoke).toHaveBeenLastCalledWith(
      WATERSHED_MESH_RPC_ID,
      {
        chunkManager: 123,
        ...h.parameters,
        generation: 7,
        objectId: 17n,
        snapshot: false,
        error: String(failure),
      },
      { signal },
    );
  });

  it("accepts exactly representable large integer placement in float32", async () => {
    const h = fixture();
    h.promiseInvoke.mockResolvedValueOnce({
      ...h.snapshot,
      lowerXYZ: [2 ** 24, 22, 33],
    });
    const native = deferNative();
    const chunk = h.fragment();
    const pending = track(
      h.source.downloadFragment(chunk, new AbortController().signal),
    );
    await native.started;
    const mesh = {
      vertexPositions: Float32Array.of(0, 0, 0, 2, 1, 0, 2, 0, 1),
      indices: Uint32Array.of(0, 1, 2),
    };
    native.resolve(mesh);
    await pending;
    expect(assign).toHaveBeenCalledExactlyOnceWith(chunk, mesh);
    expect(Array.from(mesh.vertexPositions)).toEqual([
      16777216, 22, 33, 16777218, 23, 33, 16777218, 22, 34,
    ]);
    expect(h.promiseInvoke).toHaveBeenCalledOnce();
  });

  it.each(["generation", "abort"] as const)(
    "rejects %s invalidation during the snapshot RPC before starting native work",
    async (change) => {
      const h = fixture();
      const reply = deferred<Reply>(h.snapshot);
      const requested = Promise.withResolvers<void>();
      h.promiseInvoke.mockImplementationOnce(() => {
        requested.resolve();
        return reply.promise;
      });
      const controller = new AbortController();
      const chunk = h.fragment();
      const pending = track(
        h.source.downloadFragment(chunk, controller.signal),
      );
      await requested.promise;
      if (change === "generation") ++h.state.value.generation;
      else controller.abort();
      reply.resolve(h.snapshot);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(compute).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(h.promiseInvoke).toHaveBeenCalledOnce();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "discards a stale native %s and lets the new generation run without old errors",
    async (completion) => {
      const h = fixture();
      const oldNative = deferNative();
      const oldChunk = h.fragment();
      const oldDownload = track(
        h.source.downloadFragment(oldChunk, new AbortController().signal),
      );
      await oldNative.started;
      ++h.state.value.generation;
      const latestNative = deferNative();
      const latestChunk = h.fragment();
      const latestDownload = track(
        h.source.downloadFragment(latestChunk, new AbortController().signal),
      );
      await microtasks();
      expect(h.promiseInvoke).toHaveBeenCalledOnce();
      expect(compute).toHaveBeenCalledOnce();

      const oldMesh = makeMesh();
      const oldPositions = new Float32Array(oldMesh.vertexPositions);
      const oldError = new Error(
        "Watershed mesh surface budget exceeded; use a smaller region",
      );
      if (completion === "resolve") oldNative.resolve(oldMesh);
      else oldNative.reject(oldError);
      if (completion === "resolve") {
        await expect(oldDownload).rejects.toMatchObject({ name: "AbortError" });
      } else {
        await expect(oldDownload).rejects.toBe(oldError);
      }
      expect(oldMesh.vertexPositions).toEqual(oldPositions);
      expect(assign).not.toHaveBeenCalled();
      await latestNative.started;
      expect(
        h.promiseInvoke.mock.calls.map(([, request]) => request.error),
      ).toEqual([undefined, undefined]);
      expect(h.promiseInvoke.mock.calls[1][1]).toMatchObject({
        generation: 8,
        snapshot: true,
      });
      latestNative.resolve(makeMesh());
      await latestDownload;
      expect(assign).toHaveBeenCalledOnce();
      expect(assign.mock.calls[0][0]).toBe(latestChunk);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "never assigns or reports errors after abort while native work awaits %s",
    async (completion) => {
      const h = fixture();
      const native = deferNative();
      const controller = new AbortController();
      const chunk = h.fragment();
      const pending = track(
        h.source.downloadFragment(chunk, controller.signal),
      );
      await native.started;
      controller.abort(
        new DOMException("Fragment no longer requested", "AbortError"),
      );
      const mesh = makeMesh();
      const positions = new Float32Array(mesh.vertexPositions);
      const failure = new Error(
        "Watershed mesh surface budget exceeded; use a smaller region",
      );
      if (completion === "resolve") native.resolve(mesh);
      else native.reject(failure);
      await expect(pending).rejects.toBe(
        completion === "resolve" ? controller.signal.reason : failure,
      );
      expect(mesh.vertexPositions).toEqual(positions);
      expect(assign).not.toHaveBeenCalled();
      expect(h.promiseInvoke).toHaveBeenCalledOnce();
    },
  );

  it("holds the global queue after cancellation until physical native completion, then runs only the latest queued generation", async () => {
    const first = fixture();
    const next = fixture();
    const firstNative = deferNative();
    const controller = new AbortController();
    const firstDownload = track(
      first.source.downloadFragment(first.fragment(), controller.signal),
    );
    await firstNative.started;
    const obsoleteDownload = track(
      next.source.downloadFragment(
        next.fragment(),
        new AbortController().signal,
      ),
    );
    await microtasks();
    expect(next.promiseInvoke).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledOnce();

    controller.abort();
    ++next.state.value.generation;
    const latestNative = deferNative();
    const latestChunk = next.fragment(8, 9n);
    const latestDownload = track(
      next.source.downloadFragment(latestChunk, new AbortController().signal),
    );
    await microtasks();
    // Cancellation cannot release a still-running native extraction's memory,
    // even across different source instances. No speculative snapshot either.
    expect(next.promiseInvoke).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();

    firstNative.resolve(makeMesh());
    await expect(firstDownload).rejects.toBe(controller.signal.reason);
    await expect(obsoleteDownload).rejects.toMatchObject({
      name: "AbortError",
    });
    await latestNative.started;
    expect(first.promiseInvoke).toHaveBeenCalledOnce();
    expect(next.promiseInvoke).toHaveBeenCalledOnce();
    expect(next.promiseInvoke.mock.calls[0][1]).toMatchObject({
      generation: 8,
      objectId: 9n,
      snapshot: true,
    });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(Array.from(compute.mock.calls[1][3])).toEqual([
      0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255,
    ]);
    expect(assign).not.toHaveBeenCalled();
    latestNative.resolve(makeMesh());
    await latestDownload;
    expect(assign).toHaveBeenCalledOnce();
    expect(assign.mock.calls[0][0]).toBe(latestChunk);
  });

  it.each([
    new Error("Watershed mesh surface budget exceeded; use a smaller region"),
    "Watershed mesh surface budget exceeded; use a smaller region",
  ])(
    "reports String(error) for current non-abort failures and recovers the global queue: %s",
    async (failure) => {
      const first = fixture();
      const next = fixture();
      const native = deferNative();
      const { signal } = new AbortController();
      const failedDownload = track(
        first.source.downloadFragment(first.fragment(), signal),
      );
      await native.started;
      const nextNative = deferNative();
      const nextChunk = next.fragment();
      const nextDownload = track(
        next.source.downloadFragment(nextChunk, new AbortController().signal),
      );
      native.reject(failure);
      await expect(failedDownload).rejects.toBe(failure);
      expect(first.promiseInvoke).toHaveBeenCalledTimes(2);
      expect(first.promiseInvoke).toHaveBeenLastCalledWith(
        WATERSHED_MESH_RPC_ID,
        {
          chunkManager: 123,
          ...first.parameters,
          generation: 7,
          objectId: 17n,
          snapshot: false,
          error: String(failure),
        },
        { signal },
      );
      expect(assign).not.toHaveBeenCalled();
      await nextNative.started;
      nextNative.resolve(makeMesh());
      await nextDownload;
      expect(assign).toHaveBeenCalledOnce();
      expect(assign.mock.calls[0][0]).toBe(nextChunk);
      expect(next.promiseInvoke).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, { epoch: 3, generation: 7 }])(
    "treats an unavailable snapshot (%j) as cancellation, not a frontend surface error",
    async (reply) => {
      const h = fixture();
      h.promiseInvoke.mockResolvedValueOnce(reply);
      const pending = track(
        h.source.downloadFragment(h.fragment(), new AbortController().signal),
      );
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(compute).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(
        h.promiseInvoke.mock.calls.flatMap(([, request]) =>
          request.error === undefined ? [] : [request.error],
        ),
      ).toEqual([]);
      expect(h.promiseInvoke).toHaveBeenCalledOnce();
    },
  );

  it("does not report an AbortError from native work as a frontend surface error even if the signal is still active", async () => {
    const h = fixture();
    const native = deferNative();
    const { signal } = new AbortController();
    const pending = track(h.source.downloadFragment(h.fragment(), signal));
    await native.started;
    const abort = new DOMException("Native task cancelled", "AbortError");
    native.reject(abort);
    await expect(pending).rejects.toBe(abort);
    expect(signal.aborted).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(
      h.promiseInvoke.mock.calls.flatMap(([, request]) =>
        request.error === undefined ? [] : [request.error],
      ),
    ).toEqual([]);
    expect(h.promiseInvoke).toHaveBeenCalledOnce();
  });
});
