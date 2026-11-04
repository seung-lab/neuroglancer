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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChunkManager as BackendChunkManager } from "#src/chunk_manager/backend.js";
import {
  ChunkMemoryStatistics,
  ChunkPriorityTier,
  ChunkState,
  getChunkStateStatisticIndex,
  numChunkMemoryStatistics,
} from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { DataSourceRegistry } from "#src/datasource/index.js";
import { WatershedVolumeChunkSource as BackendSource } from "#src/datasource/watershed/backend.js";
import type { LiveWatershedInfo } from "#src/datasource/watershed/base.js";
import {
  WATERSHED_RESULT_MEMORY_LIMIT,
  WATERSHED_TILE_RPC_ID,
} from "#src/datasource/watershed/base.js";
import type { WatershedMultiscaleVolumeChunkSource } from "#src/datasource/watershed/frontend.js";
import {
  publishLiveWatershed,
  publishWatershedResult,
} from "#src/datasource/watershed/frontend.js";
import { installWatershedDataSourceProvider } from "#src/datasource/watershed/register_default.js";
import { VolumeChunk } from "#src/sliceview/volume/backend.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeVolumeChunkSpecification,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import type { VolumeChunk as FrontendVolumeChunk } from "#src/sliceview/volume/frontend.js";
import "#src/sliceview/uncompressed_chunk_format.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { WatershedResult } from "#src/watershed/base.js";
import { MAX_WATERSHED_VOXELS } from "#src/watershed/base.js";
import type { LiveWatershed } from "#src/watershed/live.js";
import { RPC } from "#src/worker_rpc.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";

function makeResult(shapeXYZ = [5, 4, 3]): WatershedResult {
  const data = Uint32Array.from(
    { length: shapeXYZ.reduce((a, b) => a * b, 1) },
    (_, i) => i,
  );
  data[0] = 0xffffffff;
  return {
    data,
    shapeXYZ,
    offsetXYZ: [23.5, -11.25, 7],
    spacingXYZ: [10, 20, 30],
    unitsXYZ: ["nm", "nm", "nm"],
  };
}

const labelBase = 1n << 50n;

/** Contract-only producer: tests publication independently of input preparation. */
function makeLive(infoOverrides: Partial<LiveWatershedInfo> = {}) {
  const controller = new AbortController();
  const changed = new NullarySignal();
  const info: LiveWatershedInfo = {
    shapeXYZ: [5, 4, 3],
    offsetXYZ: [23, -11, 7],
    spacingXYZ: [1e-8, 2e-8, 3e-8],
    unitsXYZ: ["m", "m", "m"],
    chunkShapeXYZ: [3, 3, 2],
    ...infoOverrides,
  };
  const assertValid = vi.fn(() => controller.signal.throwIfAborted());
  const dispose = vi.fn(() => controller.abort());
  const readTile = vi.fn(
    async (
      lower: readonly number[],
      size: readonly number[],
      signal: AbortSignal,
    ): Promise<BigUint64Array<ArrayBuffer>> => {
      signal.throwIfAborted();
      return BigUint64Array.from(
        { length: size.reduce((a, b) => a * b, 1) },
        (_, i) =>
          labelBase +
          BigInt(
            lower[0] +
              (i % size[0]) +
              info.shapeXYZ[0] *
                (lower[1] +
                  (Math.floor(i / size[0]) % size[1]) +
                  info.shapeXYZ[1] *
                    (lower[2] + Math.floor(i / (size[0] * size[1])))),
          ),
      );
    },
  );
  const live = {
    info,
    signal: controller.signal,
    changed,
    assertValid,
    dispose,
    readTile,
  } as unknown as LiveWatershed;
  return { live, info, controller, changed, assertValid, dispose, readTile };
}

/** Real RPC handlers, async structured clone, and buffer transfer semantics. */
function createSession(waitUntilReady = false) {
  type Target = ConstructorParameters<typeof RPC>[0];
  const frontendTarget: Target = { onmessage: null, postMessage: () => {} };
  const backendTarget: Target = { onmessage: null, postMessage: () => {} };
  for (const [from, to] of [
    [frontendTarget, backendTarget],
    [backendTarget, frontendTarget],
  ]) {
    from.postMessage = (data, transfers) => {
      const copy = structuredClone(data, { transfer: transfers ?? [] });
      queueMicrotask(() => to.onmessage!({ data: copy } as MessageEvent));
    };
  }
  const frontendRpc = new RPC(frontendTarget, waitUntilReady);
  const backendRpc = new RPC(backendTarget, false);
  const managerId = 100;
  // Publication and direct backend downloads don't require a GL queue scheduler.
  const recomputeChunkPrioritiesLate = new Signal();
  const updateChunkState = vi.fn((chunk: VolumeChunk, state: ChunkState) => {
    chunk.state = state;
  });
  const backendManager = Object.assign(new RefCounted(), {
    rpc: backendRpc,
    rpcId: managerId,
    recomputeChunkPrioritiesLate,
    queueManager: { sources: new Set(), updateChunkState },
  }) as unknown as BackendChunkManager;
  backendRpc.set(managerId, backendManager);
  const invalidateCache = vi.fn();
  const source = Object.assign(new RefCounted(), { invalidateCache });
  const getChunkSource = vi.fn(
    (_constructor: unknown, _options: { spec: VolumeChunkSpecification }) =>
      source,
  );
  const frontendManager = Object.assign(new RefCounted(), {
    rpc: frontendRpc,
    rpcId: managerId,
    getChunkSource,
  }) as unknown as ChunkManager;
  frontendRpc.set(managerId, frontendManager);
  const registry = new DataSourceRegistry({
    chunkManager: frontendManager,
    kvStoreContext: { baseKvStoreProviders: new Map() },
  } as unknown as ConstructorParameters<typeof DataSourceRegistry>[0]);
  installWatershedDataSourceProvider(registry);
  return {
    frontendManager,
    backendManager,
    frontendRpc,
    backendRpc,
    registry,
    invalidateCache,
    getChunkSource,
    source,
    recomputeChunkPrioritiesLate,
    updateChunkState,
  };
}

const mockSessions: ReturnType<typeof createSession>[] = [];
function makeSession(waitUntilReady = false) {
  const session = createSession(waitUntilReady);
  mockSessions.push(session);
  return session;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const session of mockSessions.splice(0)) {
    if (!session.frontendManager.wasDisposed) session.frontendManager.dispose();
    session.backendManager.dispose();
    session.registry.dispose();
  }
});

function backendSource(
  manager: BackendChunkManager,
  resultId: string,
  size = [5, 4, 3],
  baseVoxelOffset = [0, 0, 0],
  live = false,
) {
  return Object.assign(Object.create(BackendSource.prototype), {
    chunkManager: manager,
    rpc: manager.rpc,
    parameters: { resultId, live },
    spec: makeVolumeChunkSpecification({
      rank: 3,
      dataType: live ? DataType.UINT64 : DataType.UINT32,
      chunkDataSize: Uint32Array.from(size),
      upperVoxelBound: Float32Array.of(5, 4, 3),
      baseVoxelOffset: Float32Array.from(baseVoxelOffset),
    }),
    tempChunkDataSize: new Uint32Array(3),
    tempChunkPosition: new Float32Array(3),
  }) as BackendSource;
}

function liveBackendSource(
  session: ReturnType<typeof makeSession>,
  url: string,
) {
  return backendSource(
    session.backendManager,
    url.slice(12),
    [3, 3, 2],
    [0, 0, 0],
    true,
  );
}

function makeChunk(source: BackendSource, grid = [0, 0, 0]) {
  const chunk = new VolumeChunk();
  chunk.source = source;
  chunk.initializeVolumeChunk(
    grid.join(),
    vec3.fromValues(grid[0], grid[1], grid[2]),
  );
  return chunk;
}

function getSource(
  registry: DataSourceRegistry,
  url: string,
  signal?: AbortSignal,
) {
  return registry.get({
    url,
    signal,
    transform: undefined,
    globalCoordinateSpace: new WatchableValue(
      makeCoordinateSpace({
        names: [],
        units: [],
        scales: new Float64Array(0),
      }),
    ),
  });
}

const sourceOptions = {
  multiscaleToViewTransform: Float32Array.of(
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
  ),
  displayRank: 3,
  modelChannelDimensionIndices: [],
};
const signal = new AbortController().signal;

describe("session-local watershed volume RPC", () => {
  it("publishes synchronously before worker startup, snapshots immediately, and resolves without RPC", async () => {
    const session = makeSession(true);
    const invoke = vi.spyOn(session.frontendRpc, "invoke");
    const input = makeResult();
    const handle = publishWatershedResult(session.frontendManager, input);
    expect(handle.url).toMatch(/^watershed:\/\/[a-f0-9]{32}$/);
    expect(handle).not.toBeInstanceOf(Promise);
    input.data.fill(17);
    (input.shapeXYZ as number[])[0] = 1;
    (input.offsetXYZ as number[])[0] = 99;
    (input.spacingXYZ as number[])[0] = 99;
    (input.unitsXYZ as string[])[0] = "m";
    const dataSource = await getSource(session.registry, handle.url);
    expect(invoke).not.toHaveBeenCalled();
    const { modelTransform } = dataSource;
    expect(modelTransform.rank).toBe(3);
    expect(modelTransform.inputSpace.names).toEqual(["x", "y", "z"]);
    expect(modelTransform.inputSpace.units).toEqual(["m", "m", "m"]);
    expect(Array.from(modelTransform.inputSpace.scales)).toEqual([
      1e-8, 2e-8, 3e-8,
    ]);
    expect(modelTransform.outputSpace.names).toEqual(["x", "y", "z"]);
    expect(Array.from(modelTransform.outputSpace.scales)).toEqual([
      1e-8, 2e-8, 3e-8,
    ]);
    expect(Array.from(modelTransform.inputSpace.bounds.lowerBounds)).toEqual([
      0, 0, 0,
    ]);
    expect(Array.from(modelTransform.inputSpace.bounds.upperBounds)).toEqual([
      5, 4, 3,
    ]);
    expect(Array.from(modelTransform.transform!.slice(12))).toEqual([
      23.5, -11.25, 7, 1,
    ]);
    expect(dataSource.canonicalUrl).toBe(handle.url);
    expect(dataSource.canChangeModelSpaceRank).toBe(false);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    expect(volume.rank).toBe(3);
    expect(volume.dataType).toBe(DataType.UINT32);
    expect(volume.volumeType).toBe(VolumeType.SEGMENTATION);
    const sources = volume.getSources(sourceOptions);
    volume.getSources(sourceOptions);
    const spec = session.getChunkSource.mock.calls[0][1].spec;
    expect(Array.from(spec.upperVoxelBound)).toEqual([5, 4, 3]);
    expect(Array.from(spec.chunkDataSize)).toEqual([5, 4, 3]);
    expect(Array.from(spec.baseVoxelOffset)).toEqual([0, 0, 0]);
    expect(spec.dataType).toBe(DataType.UINT32);
    expect(sources[0][0].chunkToMultiscaleTransform).toEqual(
      matrix.createIdentity(Float32Array, 4),
    );
    const source = backendSource(session.backendManager, handle.url.slice(12));
    const chunk = makeChunk(source);
    const pending = source.download(chunk, signal);
    session.frontendRpc.onPeerReady();
    await pending;
    expect(chunk.data).toEqual(makeResult().data);
    expect(input.data.byteLength).toBe(240);
    handle.dispose();
    handle.dispose();
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "Rerun watershed.",
    );
    expect(() => volume.getSources(sourceOptions)).toThrow("unavailable");
    await expect(source.download(makeChunk(source), signal)).rejects.toThrow(
      "unavailable",
    );
  });

  it("bounds display tiles to 32 cubed and canonicalizes mixed supported units", async () => {
    const session = makeSession();
    const handle = publishWatershedResult(session.frontendManager, {
      ...makeResult([35, 2, 34]),
      unitsXYZ: ["µm", "", "m"],
      spacingXYZ: [2, 3, 4e-9],
    });
    const dataSource = await getSource(session.registry, handle.url);
    expect(dataSource.modelTransform.inputSpace.units).toEqual(["m", "", "m"]);
    expect(Array.from(dataSource.modelTransform.inputSpace.scales)).toEqual([
      2e-6, 3, 4e-9,
    ]);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    volume.getSources(sourceOptions);
    expect(
      Array.from(session.getChunkSource.mock.calls[0][1].spec.chunkDataSize),
    ).toEqual([32, 2, 32]);
    handle.dispose();
  });

  it("copies clipped local edge chunks, captures scratch bounds, and survives repeated transfers", async () => {
    const session = makeSession();
    const input = makeResult();
    const handle = publishWatershedResult(session.frontendManager, input);
    const source = backendSource(
      session.backendManager,
      handle.url.slice(12),
      [3, 3, 2],
      [101, 211, 307],
    );
    const edge = makeChunk(source, [1, 1, 1]);
    const other = makeChunk(source);
    await Promise.all([
      source.download(edge, signal),
      source.download(other, signal),
    ]);
    expect(Array.from(edge.chunkDataSize!)).toEqual([2, 1, 1]);
    expect(edge.data).toEqual(Uint32Array.of(58, 59));
    expect((other.data as Uint32Array)[0]).toBe(0xffffffff);
    const copy = edge.data as Uint32Array;
    const message: Record<string, unknown> = {};
    const transfers: Transferable[] = [];
    edge.serialize(message, transfers);
    const delivered = structuredClone(message, { transfer: transfers });
    expect(copy.byteLength).toBe(0);
    (delivered.data as Uint32Array).fill(99);
    input.data.fill(77);
    await source.download(edge, signal);
    expect(edge.data).toEqual(Uint32Array.of(58, 59));
    handle.dispose();
  });

  it("rejects invalid publications, chunk bounds, cancellation, and invalid worker replies", async () => {
    const session = makeSession();
    expect(() =>
      publishWatershedResult(session.frontendManager, {
        ...makeResult(),
        data: new Float32Array(60) as unknown as Uint32Array,
      }),
    ).toThrow("Uint32Array");
    expect(() =>
      publishWatershedResult(session.frontendManager, {
        ...makeResult(),
        unitsXYZ: ["invalid", "m", "m"],
      }),
    ).toThrow("units");
    const handle = publishWatershedResult(
      session.frontendManager,
      makeResult(),
    );
    const source = backendSource(session.backendManager, handle.url.slice(12));
    for (const grid of [
      [-1, 0, 0],
      [1, 0, 0],
    ]) {
      const chunk = makeChunk(source, grid);
      await expect(source.download(chunk, signal)).rejects.toThrow(
        "outside result bounds",
      );
      expect(chunk.data).toBeNull();
    }
    const cancelled = new AbortController();
    const chunk = makeChunk(source);
    const pending = source.download(chunk, cancelled.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    cancelled.abort();
    await rejected;
    expect(chunk.data).toBeNull();
    await expect(
      getSource(session.registry, handle.url, cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const rpc = vi.spyOn(session.backendRpc, "promiseInvoke");
    for (const value of [new Float32Array(60), new Uint32Array(59)]) {
      rpc.mockResolvedValueOnce(value);
      await expect(source.download(makeChunk(source), signal)).rejects.toThrow(
        "Invalid watershed tile data",
      );
    }
    handle.dispose();
  });

  it("reports unavailable session URLs across managers/reloads and cleans up at teardown", async () => {
    const session = makeSession();
    const other = makeSession();
    await expect(
      getSource(session.registry, "watershed://abc"),
    ).rejects.toThrow("unavailable");
    const handle = publishWatershedResult(
      session.frontendManager,
      makeResult(),
    );
    await expect(getSource(other.registry, handle.url)).rejects.toThrow(
      "Rerun watershed.",
    );
    const dataSource = await getSource(session.registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    volume.getSources(sourceOptions);
    session.frontendManager.dispose();
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    const source = backendSource(session.backendManager, handle.url.slice(12));
    await expect(source.download(makeChunk(source), signal)).rejects.toThrow(
      "Rerun watershed.",
    );
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "unavailable",
    );
    expect(() =>
      publishWatershedResult(session.frontendManager, makeResult()),
    ).toThrow("disposed ChunkManager");
    handle.dispose();
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("removes disposed sources from invalidation tracking", async () => {
    const session = makeSession();
    const handle = publishWatershedResult(
      session.frontendManager,
      makeResult(),
    );
    const dataSource = await getSource(session.registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    volume.getSources(sourceOptions);
    session.source.dispose();
    handle.dispose();
    expect(session.invalidateCache).not.toHaveBeenCalled();
  });

  it("bounds aggregate snapshots plus metadata per manager and reclaims disposal capacity", () => {
    const session = makeSession();
    const input = {
      ...makeResult([128, 128, 128]),
      data: new Uint32Array(MAX_WATERSHED_VOXELS),
    };
    const count = WATERSHED_RESULT_MEMORY_LIMIT / input.data.byteLength - 1;
    const handles = Array.from({ length: count }, () =>
      publishWatershedResult(session.frontendManager, input),
    );
    expect(() =>
      publishWatershedResult(session.frontendManager, input),
    ).toThrow("128 MiB session memory limit");
    const other = makeSession();
    const independent = publishWatershedResult(other.frontendManager, input);
    handles.pop()!.dispose();
    const reclaimed = publishWatershedResult(session.frontendManager, input);
    expect(() =>
      publishWatershedResult(session.frontendManager, input),
    ).toThrow("128 MiB session memory limit");
    reclaimed.dispose();
    independent.dispose();
    for (const handle of handles) handle.dispose();
    const afterAllDisposed = publishWatershedResult(
      session.frontendManager,
      input,
    );
    afterAllDisposed.dispose();
  });

  it("rejects malformed frontend tile requests without exposing snapshots", async () => {
    const session = makeSession();
    const handle = publishWatershedResult(
      session.frontendManager,
      makeResult(),
    );
    await expect(
      session.backendRpc.promiseInvoke(WATERSHED_TILE_RPC_ID, {
        chunkManager: 100,
        resultId: handle.url.slice(12),
        lowerXYZ: [4, 0, 0],
        sizeXYZ: [2, 1, 1],
      }),
    ).rejects.toThrow("outside result bounds");
    handle.dispose();
  });
});

describe("session-local live watershed volume RPC", () => {
  it("publishes metadata synchronously across the full live domain without starting work or RPC", async () => {
    const session = makeSession(true);
    const producer = makeLive({
      shapeXYZ: [327680, 327680, 327680],
      chunkShapeXYZ: [64, 64, 32],
    });
    const invoke = vi.spyOn(session.frontendRpc, "invoke");
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    expect(handle).not.toBeInstanceOf(Promise);
    expect(handle.url).toMatch(/^watershed:\/\/[a-f0-9]{32}$/);
    (producer.info.shapeXYZ as number[])[0] = 1;
    (producer.info.chunkShapeXYZ as number[])[0] = 1;
    const dataSource = await getSource(session.registry, handle.url);
    const { modelTransform } = dataSource;
    expect(modelTransform.inputSpace.names).toEqual(["x", "y", "z"]);
    expect(modelTransform.inputSpace.units).toEqual(["m", "m", "m"]);
    expect(Array.from(modelTransform.inputSpace.scales)).toEqual([
      1e-8, 2e-8, 3e-8,
    ]);
    expect(Array.from(modelTransform.inputSpace.bounds.lowerBounds)).toEqual([
      0, 0, 0,
    ]);
    expect(Array.from(modelTransform.inputSpace.bounds.upperBounds)).toEqual([
      327680, 327680, 327680,
    ]);
    expect(Array.from(modelTransform.transform!.slice(12))).toEqual([
      23, -11, 7, 1,
    ]);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    expect(volume.dataType).toBe(DataType.UINT64);
    expect(volume.volumeType).toBe(VolumeType.SEGMENTATION);
    const sources = volume.getSources(sourceOptions);
    const options = session.getChunkSource.mock.calls[0][1];
    expect(options.spec.dataType).toBe(DataType.UINT64);
    expect(Array.from(options.spec.chunkDataSize)).toEqual([64, 64, 32]);
    expect(Array.from(options.spec.upperVoxelBound)).toEqual([
      327680, 327680, 327680,
    ]);
    expect(Array.from(options.spec.baseVoxelOffset)).toEqual([0, 0, 0]);
    expect(sources[0][0].chunkToMultiscaleTransform).toEqual(
      matrix.createIdentity(Float32Array, 4),
    );
    expect(options).toMatchObject({
      parameters: { live: true, resultId: handle.url.slice(12) },
    });
    expect(producer.readTile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    handle.dispose();
    handle.dispose();
    expect(producer.dispose).toHaveBeenCalledTimes(1);
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    expect(producer.controller.signal.aborted).toBe(true);
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "unavailable",
    );
  });

  it("invalidates all registered display caches synchronously on regional changes without retiring the URL", async () => {
    const session = makeSession();
    const producer = makeLive();
    const removeChanged = vi.spyOn(producer.changed, "remove");
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const dataSource = await getSource(session.registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    const otherSource = Object.assign(new RefCounted(), {
      invalidateCache: vi.fn(),
    });
    session.getChunkSource
      .mockReturnValueOnce(session.source)
      .mockReturnValueOnce(otherSource);
    volume.getSources(sourceOptions);
    volume.getSources(sourceOptions);
    volume.getSources(sourceOptions);
    producer.changed.dispatch();
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    expect(otherSource.invalidateCache).toHaveBeenCalledTimes(1);
    expect(producer.dispose).not.toHaveBeenCalled();
    expect(producer.live.signal.aborted).toBe(false);
    expect((await getSource(session.registry, handle.url)).canonicalUrl).toBe(
      handle.url,
    );
    expect(producer.readTile).not.toHaveBeenCalled();
    otherSource.dispose();
    producer.changed.dispatch();
    expect(session.invalidateCache).toHaveBeenCalledTimes(2);
    expect(otherSource.invalidateCache).toHaveBeenCalledTimes(1);
    handle.dispose();
    handle.dispose();
    expect(removeChanged).toHaveBeenCalledTimes(1);
    expect(producer.dispose).toHaveBeenCalledTimes(1);
    expect(session.invalidateCache).toHaveBeenCalledTimes(3);
    producer.changed.dispatch();
    expect(session.invalidateCache).toHaveBeenCalledTimes(3);
  });

  it.each(["changed observer", "cache observer"] as const)(
    "allows a %s to dispose the publication reentrantly without skipping caches or recursing",
    async (kind) => {
      const session = makeSession();
      const producer = makeLive();
      const removeChanged = vi.spyOn(producer.changed, "remove");
      if (kind === "changed observer") {
        producer.changed.add(() => handle.dispose());
      } else {
        session.invalidateCache.mockImplementationOnce(() => handle.dispose());
      }
      const handle = publishLiveWatershed(
        session.frontendManager,
        producer.live,
      );
      const dataSource = await getSource(session.registry, handle.url);
      const volume = dataSource.subsources[0].subsource
        .volume as WatershedMultiscaleVolumeChunkSource;
      const otherSource = Object.assign(new RefCounted(), {
        invalidateCache: vi.fn(),
      });
      session.getChunkSource
        .mockReturnValueOnce(session.source)
        .mockReturnValueOnce(otherSource);
      volume.getSources(sourceOptions);
      volume.getSources(sourceOptions);
      producer.changed.dispatch();
      expect(session.invalidateCache).toHaveBeenCalledTimes(1);
      expect(otherSource.invalidateCache).toHaveBeenCalledTimes(1);
      expect(producer.dispose).toHaveBeenCalledTimes(1);
      expect(removeChanged).toHaveBeenCalledTimes(1);
      await expect(getSource(session.registry, handle.url)).rejects.toThrow(
        "unavailable",
      );
      producer.changed.dispatch();
      handle.dispose();
      expect(session.invalidateCache).toHaveBeenCalledTimes(1);
      expect(otherSource.invalidateCache).toHaveBeenCalledTimes(1);
      otherSource.dispose();
    },
  );

  it("transfers exact UINT64 full/partial tile copies using local bounds repeatedly", async () => {
    const session = makeSession();
    const producer = makeLive();
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const source = liveBackendSource(session, handle.url);
    const first = makeChunk(source);
    const edge = makeChunk(source, [1, 1, 1]);
    await Promise.all([
      source.download(edge, signal),
      source.download(first, signal),
    ]);
    expect(
      producer.readTile.mock.calls.map(([lower, size]) => [lower, size]),
    ).toEqual([
      [
        [3, 3, 2],
        [2, 1, 1],
      ],
      [
        [0, 0, 0],
        [3, 3, 2],
      ],
    ]);
    expect(Array.from(edge.chunkDataSize!)).toEqual([2, 1, 1]);
    expect(edge.data).toEqual(
      BigUint64Array.of(labelBase + 58n, labelBase + 59n),
    );
    expect((first.data as BigUint64Array)[0]).toBe(labelBase);
    const old = edge.data as BigUint64Array;
    const message: Record<string, unknown> = {};
    const transfers: Transferable[] = [];
    edge.serialize(message, transfers);
    const delivered = structuredClone(message, { transfer: transfers });
    expect(old.byteLength).toBe(0);
    (delivered.data as BigUint64Array).fill(0n);
    await source.download(edge, signal);
    expect(edge.data).toEqual(
      BigUint64Array.of(labelBase + 58n, labelBase + 59n),
    );
    expect(producer.readTile).toHaveBeenCalledTimes(3);
    handle.dispose();
  });

  it("gives shared/subarray producer replies independent exact transferable buffers without caching", async () => {
    const session = makeSession();
    const producer = makeLive();
    const shared = new BigUint64Array(20).fill(labelBase);
    producer.readTile.mockResolvedValue(shared.subarray(1, 19));
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const source = liveBackendSource(session, handle.url);
    const first = makeChunk(source);
    const second = makeChunk(source);
    await Promise.all([
      source.download(first, signal),
      source.download(second, signal),
    ]);
    const data = first.data as BigUint64Array;
    expect(data).toEqual(new BigUint64Array(18).fill(labelBase));
    expect(data.byteOffset).toBe(0);
    expect(data.buffer.byteLength).toBe(18 * 8);
    expect(data.buffer).not.toBe((second.data as BigUint64Array).buffer);
    data[0] = 0n;
    expect((second.data as BigUint64Array)[0]).toBe(labelBase);
    expect(shared).toEqual(new BigUint64Array(20).fill(labelBase));
    expect(producer.readTile).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it("rejects malformed/non-aligned frontend requests before asking the producer", async () => {
    const session = makeSession();
    const producer = makeLive();
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    for (const [lowerXYZ, sizeXYZ] of [
      [
        [1, 0, 0],
        [3, 3, 2],
      ],
      [
        [3, 3, 2],
        [3, 1, 1],
      ],
      [
        [0, 0],
        [3, 3, 2],
      ],
    ]) {
      await expect(
        session.backendRpc.promiseInvoke(WATERSHED_TILE_RPC_ID, {
          chunkManager: 100,
          resultId: handle.url.slice(12),
          live: true,
          lowerXYZ,
          sizeXYZ,
        }),
      ).rejects.toThrow(/bounds/);
    }
    expect(producer.readTile).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("rejects wrong producer and worker UINT64 types/counts without publishing chunk data", async () => {
    const session = makeSession();
    const producer = makeLive();
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const source = liveBackendSource(session, handle.url);
    for (const data of [
      new Uint32Array(18),
      new Float64Array(18),
      new BigUint64Array(17),
    ]) {
      producer.readTile.mockResolvedValueOnce(
        data as BigUint64Array<ArrayBuffer>,
      );
      const chunk = makeChunk(source);
      await expect(source.download(chunk, signal)).rejects.toThrow(
        "Invalid live watershed tile data",
      );
      expect(chunk.data).toBeNull();
    }
    const invoke = vi.spyOn(session.backendRpc, "promiseInvoke");
    for (const data of [new Uint32Array(18), new BigUint64Array(17)]) {
      invoke.mockResolvedValueOnce(data);
      const chunk = makeChunk(source);
      await expect(source.download(chunk, signal)).rejects.toThrow(
        "Invalid watershed tile data",
      );
      expect(chunk.data).toBeNull();
    }
    handle.dispose();
  });

  it("cancels a noncooperative in-flight read promptly and discards its late result", async () => {
    const session = makeSession();
    const producer = makeLive();
    const late = Promise.withResolvers<BigUint64Array<ArrayBuffer>>();
    producer.readTile.mockImplementationOnce(() => late.promise);
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const source = liveBackendSource(session, handle.url);
    const chunk = makeChunk(source);
    const controller = new AbortController();
    const pending = source.download(chunk, controller.signal);
    await expect.poll(() => producer.readTile.mock.calls.length).toBe(1);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(producer.readTile.mock.calls[0][2].aborted).toBe(true);
    expect(chunk.data).toBeNull();
    late.resolve(new BigUint64Array(18).fill(999n));
    await Promise.resolve();
    expect(chunk.data).toBeNull();
    await source.download(chunk, signal);
    expect((chunk.data as BigUint64Array)[0]).toBe(labelBase);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      source.download(makeChunk(source), alreadyAborted.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(producer.readTile).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it.each(["publication", "source", "manager"] as const)(
    "expires %s lifetime, aborts pending work, and waits for scheduler cancellation instead of FAILED",
    async (kind) => {
      const session = makeSession();
      const producer = makeLive();
      const removeChanged = vi.spyOn(producer.changed, "remove");
      const removeAbort = vi.spyOn(producer.live.signal, "removeEventListener");
      const late = Promise.withResolvers<BigUint64Array<ArrayBuffer>>();
      producer.readTile.mockImplementationOnce(() => late.promise);
      const handle = publishLiveWatershed(
        session.frontendManager,
        producer.live,
      );
      const dataSource = await getSource(session.registry, handle.url);
      const volume = dataSource.subsources[0].subsource
        .volume as WatershedMultiscaleVolumeChunkSource;
      volume.getSources(sourceOptions);
      const source = liveBackendSource(session, handle.url);
      const chunk = makeChunk(source);
      const controller = new AbortController();
      const pending = source.download(chunk, controller.signal);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await expect.poll(() => producer.readTile.mock.calls.length).toBe(1);
      if (kind === "publication") handle.dispose();
      else if (kind === "source")
        producer.controller.abort(new Error("Input source disappeared"));
      else session.frontendManager.dispose();
      expect(producer.dispose).toHaveBeenCalledTimes(1);
      expect(removeChanged).toHaveBeenCalledTimes(1);
      expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
      producer.changed.dispatch();
      expect(session.invalidateCache).toHaveBeenCalledTimes(1);
      expect(producer.readTile.mock.calls[0][2].aborted).toBe(true);
      await expect(getSource(session.registry, handle.url)).rejects.toThrow(
        "unavailable",
      );
      expect(() => volume.getSources(sourceOptions)).toThrow("unavailable");
      late.resolve(new BigUint64Array(18).fill(999n));
      // Let both RPC legs complete; the worker waits for its scheduler's abort.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(chunk.data).toBeNull();
      expect(chunk.error).toBeNull();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      controller.abort();
      await rejected;
      handle.dispose();
      expect(producer.dispose).toHaveBeenCalledTimes(1);
      expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    },
  );

  it("treats already removed and cross-manager live demand as cancellation, not a failed cached tile", async () => {
    const session = makeSession();
    const other = makeSession();
    const producer = makeLive();
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    await expect(getSource(other.registry, handle.url)).rejects.toThrow(
      "unavailable",
    );
    handle.dispose();
    for (const owner of [session, other]) {
      const source = liveBackendSource(owner, handle.url);
      const controller = new AbortController();
      const chunk = makeChunk(source);
      const pending = source.download(chunk, controller.signal);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(chunk.data).toBeNull();
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      controller.abort();
      await rejected;
    }
    expect(producer.readTile).not.toHaveBeenCalled();
  });

  it("owns and releases invalid or already-disposed producers even on synchronous publication failure", () => {
    const session = makeSession();
    const invalid = makeLive({ unitsXYZ: ["nm", "m", "m"] });
    expect(() =>
      publishLiveWatershed(session.frontendManager, invalid.live),
    ).toThrow("canonical");
    expect(invalid.dispose).toHaveBeenCalledTimes(1);
    const aborted = makeLive();
    aborted.controller.abort();
    expect(() =>
      publishLiveWatershed(session.frontendManager, aborted.live),
    ).toThrow(aborted.live.signal.reason);
    expect(aborted.dispose).toHaveBeenCalledTimes(1);
    session.frontendManager.dispose();
    const disposedManager = makeLive();
    expect(() =>
      publishLiveWatershed(session.frontendManager, disposedManager.live),
    ).toThrow("disposed ChunkManager");
    expect(disposedManager.dispose).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes regional changes if publication fails after subscribing", () => {
    const session = makeSession();
    const producer = makeLive();
    const addChanged = vi.spyOn(producer.changed, "add");
    const removeChanged = vi.spyOn(producer.changed, "remove");
    const removeAbort = vi.spyOn(producer.live.signal, "removeEventListener");
    vi.spyOn(producer.live.signal, "addEventListener").mockImplementationOnce(
      () => {
        throw new Error("abort listener setup failed");
      },
    );
    expect(() =>
      publishLiveWatershed(session.frontendManager, producer.live),
    ).toThrow("abort listener setup failed");
    expect(addChanged).toHaveBeenCalledTimes(1);
    expect(removeChanged).toHaveBeenCalledTimes(1);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(producer.dispose).toHaveBeenCalledTimes(1);
    producer.changed.dispatch();
    expect(session.invalidateCache).not.toHaveBeenCalled();
  });

  it("rechecks producer validity on access and invalidates previously resolved sources", async () => {
    const session = makeSession();
    const producer = makeLive();
    const handle = publishLiveWatershed(session.frontendManager, producer.live);
    const dataSource = await getSource(session.registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    volume.getSources(sourceOptions);
    producer.assertValid.mockImplementation(() => {
      throw new Error("source invalid");
    });
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "unavailable",
    );
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    expect(producer.dispose).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("uses queue level 2 and cancels only demoted live downloads before their abort handler can publish FAILED", () => {
    const session = makeSession();
    function construct(live: boolean) {
      const spec = liveBackendSource(session, "watershed://abc").spec;
      const source = new BackendSource(session.backendRpc, {
        chunkManager: 100,
        parameters: { resultId: "abc", live },
        spec,
      });
      // This isolated test has no corresponding shared frontend source.
      source.isOwner = undefined;
      session.backendManager.registerDisposer(() => {
        if (!source.wasDisposed) source.dispose();
      });
      return source;
    }
    const source = construct(true);
    const snapshot = construct(false);
    expect(source.sourceQueueLevel).toBe(2);
    expect(snapshot.sourceQueueLevel).toBe(2);
    function downloading(
      owner: BackendSource,
      grid: number[],
      tier: ChunkPriorityTier,
    ) {
      const chunk = makeChunk(owner, grid);
      chunk.state = ChunkState.DOWNLOADING;
      chunk.newPriorityTier = tier;
      chunk.downloadAbortController = new AbortController();
      owner.chunks.set(chunk.key!, chunk);
      return chunk;
    }
    const demoted = downloading(source, [0, 0, 0], ChunkPriorityTier.RECENT);
    const visible = downloading(source, [1, 0, 0], ChunkPriorityTier.VISIBLE);
    const prefetch = downloading(source, [0, 1, 0], ChunkPriorityTier.PREFETCH);
    const oldSnapshot = downloading(
      snapshot,
      [0, 0, 0],
      ChunkPriorityTier.RECENT,
    );
    const aborted = demoted.downloadAbortController!;
    const clearedBeforeAbort = vi.fn(() =>
      expect(demoted.downloadAbortController).toBeUndefined(),
    );
    aborted.signal.addEventListener("abort", clearedBeforeAbort);
    session.recomputeChunkPrioritiesLate.dispatch();
    expect(clearedBeforeAbort).toHaveBeenCalledTimes(1);
    expect(aborted.signal.aborted).toBe(true);
    expect(aborted.signal.reason.name).toBe("AbortError");
    expect(demoted.state).toBe(ChunkState.QUEUED);
    expect(demoted.error).toBeNull();
    expect(visible.downloadAbortController!.signal.aborted).toBe(false);
    expect(prefetch.downloadAbortController!.signal.aborted).toBe(false);
    expect(oldSnapshot.downloadAbortController!.signal.aborted).toBe(false);
    expect(session.updateChunkState).toHaveBeenCalledTimes(1);
    source.dispose();
    demoted.state = ChunkState.DOWNLOADING;
    demoted.downloadAbortController = new AbortController();
    session.recomputeChunkPrioritiesLate.dispatch();
    expect(demoted.downloadAbortController.signal.aborted).toBe(false);
  });
});

describe("production chunk worker watershed registration", () => {
  const registryFixture = dataSourceProviderFixture();

  it("downloads real UINT32 chunks through frontend RPC and redownloads after transfer/invalidation", async () => {
    const registry = await registryFixture();
    const input = makeResult([35, 34, 33]);
    const handle = publishWatershedResult(registry.chunkManager, input);
    const dataSource = await getSource(registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    const source = volume.getSources(sourceOptions)[0][0].chunkSource;
    try {
      const first = await source.fetchChunk(
        new Float32Array(3),
        (chunk) =>
          (chunk as FrontendVolumeChunk).getValueAt(new Uint32Array(3)),
        {},
      );
      expect(first).toBe(0xffffffff);
      const readEdge = () =>
        source.fetchChunk(
          Float32Array.of(1, 1, 1),
          (chunk) => {
            const volumeChunk = chunk as FrontendVolumeChunk;
            return {
              shape: Array.from(volumeChunk.chunkDataSize),
              values: Array.from({ length: 6 }, (_, i) =>
                volumeChunk.getValueAt(
                  Uint32Array.of(i % 3, Math.floor(i / 3), 0),
                ),
              ),
            };
          },
          {},
        );
      const edge = await readEdge();
      expect(edge).toEqual({
        shape: [3, 2, 1],
        values: [39232, 39233, 39234, 39267, 39268, 39269],
      });
      input.data.fill(0);
      source.invalidateCache();
      await expect.poll(() => source.chunks.size).toBe(0);
      expect(await readEdge()).toEqual(edge);
      handle.dispose();
      await expect.poll(() => source.chunks.size).toBe(0);
      await expect(readEdge()).rejects.toThrow("Rerun watershed.");
      await expect(getSource(registry, handle.url)).rejects.toThrow(
        "unavailable",
      );
    } finally {
      handle.dispose();
      source.dispose();
    }
  }, 20000);

  it("downloads and normally caches UINT64 full/edge chunks in the real worker", async () => {
    const registry = await registryFixture();
    const producer = makeLive();
    const handle = publishLiveWatershed(registry.chunkManager, producer.live);
    const dataSource = await getSource(registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    const source = volume.getSources(sourceOptions)[0][0].chunkSource;
    try {
      const readFirst = () =>
        source.fetchChunk(
          new Float32Array(3),
          (chunk) =>
            (chunk as FrontendVolumeChunk).getValueAt(new Uint32Array(3)),
          {},
        );
      expect(await readFirst()).toBe(labelBase);
      expect(await readFirst()).toBe(labelBase);
      expect(producer.readTile).toHaveBeenCalledTimes(1);
      const readEdge = () =>
        source.fetchChunk(
          Float32Array.of(1, 1, 1),
          (chunk) => {
            const volumeChunk = chunk as FrontendVolumeChunk;
            return {
              shape: Array.from(volumeChunk.chunkDataSize),
              values: [0, 1].map((x) =>
                volumeChunk.getValueAt(Uint32Array.of(x, 0, 0)),
              ),
            };
          },
          {},
        );
      const edge = {
        shape: [2, 1, 1],
        values: [labelBase + 58n, labelBase + 59n],
      };
      expect(await readEdge()).toEqual(edge);
      source.invalidateCache();
      await expect.poll(() => source.chunks.size).toBe(0);
      expect(await readEdge()).toEqual(edge);
      expect(producer.readTile).toHaveBeenCalledTimes(3);
      handle.dispose();
      await expect.poll(() => source.chunks.size).toBe(0);
      expect(producer.dispose).toHaveBeenCalledTimes(1);
      await expect(getSource(registry, handle.url)).rejects.toThrow(
        "unavailable",
      );
    } finally {
      handle.dispose();
      source.dispose();
    }
  }, 20000);

  it("refreshes cached display chunks from one regional result on changed while keeping the real-worker URL alive", async () => {
    const registry = await registryFixture();
    const producer = makeLive({
      shapeXYZ: [67, 65, 33],
      chunkShapeXYZ: [64, 64, 32],
    });
    const voxelCount = 67 * 65 * 33;
    const initial = new Uint32Array(voxelCount).fill(17);
    let result: Uint32Array | undefined = initial;
    const copies: BigUint64Array[] = [];
    producer.readTile.mockImplementation(async (lower, size, signal) => {
      signal.throwIfAborted();
      const copy = new BigUint64Array(size[0] * size[1] * size[2]);
      let target = 0;
      for (let z = 0; z < size[2]; ++z) {
        for (let y = 0; y < size[1]; ++y) {
          const start = lower[0] + 67 * (lower[1] + y + 65 * (lower[2] + z));
          for (let x = 0; x < size[0]; ++x) {
            copy[target++] = BigInt(result?.[start + x] ?? 0);
          }
        }
      }
      copies.push(copy);
      return copy;
    });
    const handle = publishLiveWatershed(registry.chunkManager, producer.live);
    const dataSource = await getSource(registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    const source = volume.getSources(sourceOptions)[0][0].chunkSource;
    const invalidated = vi.fn();
    const removeInvalidated = source.cacheInvalidated.add(invalidated);
    const read = (grid: number[], local: number[]) =>
      source.fetchChunk(
        Float32Array.from(grid),
        (chunk) => {
          const volumeChunk = chunk as FrontendVolumeChunk;
          return {
            shape: Array.from(volumeChunk.chunkDataSize),
            label: volumeChunk.getValueAt(Uint32Array.from(local)),
          };
        },
        {},
      );
    const readAcrossChunks = async (label: bigint) => {
      // Adjacent voxels across a transport boundary share regional label IDs.
      expect(await read([0, 0, 0], [63, 0, 0])).toEqual({
        shape: [64, 64, 32],
        label,
      });
      expect(await read([1, 0, 0], [0, 0, 0])).toEqual({
        shape: [3, 64, 32],
        label,
      });
      expect(await read([1, 1, 1], [2, 0, 0])).toEqual({
        shape: [3, 1, 1],
        label,
      });
    };
    const change = async () => {
      const count = invalidated.mock.calls.length;
      producer.changed.dispatch();
      expect(invalidated).toHaveBeenCalledTimes(count + 1);
      expect(producer.live.signal.aborted).toBe(false);
      expect(producer.dispose).not.toHaveBeenCalled();
      expect((await getSource(registry, handle.url)).canonicalUrl).toBe(
        handle.url,
      );
      await expect.poll(() => source.chunks.size).toBe(0);
    };
    try {
      expect(volume.dataType).toBe(DataType.UINT64);
      await readAcrossChunks(17n);
      await readAcrossChunks(17n);
      expect(producer.readTile).toHaveBeenCalledTimes(3);
      expect(source.chunks.size).toBe(3);
      // A desired-region change clears old labels before the next result exists.
      result = undefined;
      await change();
      await readAcrossChunks(0n);
      const completed = new Uint32Array(voxelCount).fill(29);
      result = completed;
      await change();
      await readAcrossChunks(29n);
      await readAcrossChunks(29n);
      expect(producer.readTile).toHaveBeenCalledTimes(9);
      // Neither the authoritative regional result nor producer tile replies may
      // be detached by either RPC leg or mutated by the normal display cache.
      expect(initial.byteLength).toBe(voxelCount * 4);
      expect(initial.every((x) => x === 17)).toBe(true);
      expect(completed.byteLength).toBe(voxelCount * 4);
      expect(completed.every((x) => x === 29)).toBe(true);
      expect(copies.every((copy) => copy.byteLength > 0)).toBe(true);
      expect(copies[0][0]).toBe(17n);
      expect(copies[6][0]).toBe(29n);
      // A regional error also clears the display without expiring publication.
      result = undefined;
      await change();
      await readAcrossChunks(0n);
      expect(producer.readTile).toHaveBeenCalledTimes(12);
      handle.dispose();
      handle.dispose();
      await expect.poll(() => source.chunks.size).toBe(0);
      expect(producer.dispose).toHaveBeenCalledTimes(1);
      const count = invalidated.mock.calls.length;
      producer.changed.dispatch();
      expect(invalidated).toHaveBeenCalledTimes(count);
      await expect(getSource(registry, handle.url)).rejects.toThrow(
        "unavailable",
      );
    } finally {
      removeInvalidated();
      handle.dispose();
      source.dispose();
    }
  }, 20000);

  it.each(["publication", "source"] as const)(
    "expires in-flight real-worker demand without caching FAILED (%s)",
    async (kind) => {
      const registry = await registryFixture();
      const producer = makeLive();
      const late = Promise.withResolvers<BigUint64Array<ArrayBuffer>>();
      producer.readTile.mockImplementationOnce(() => late.promise);
      const handle = publishLiveWatershed(registry.chunkManager, producer.live);
      const dataSource = await getSource(registry, handle.url);
      const volume = dataSource.subsources[0].subsource
        .volume as WatershedMultiscaleVolumeChunkSource;
      const source = volume.getSources(sourceOptions)[0][0].chunkSource;
      const controller = new AbortController();
      try {
        const publish = vi.fn(() => undefined);
        const pending = source.fetchChunk(new Float32Array(3), publish, {
          signal: controller.signal,
        });
        let settled = false;
        void pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        await expect.poll(() => producer.readTile.mock.calls.length).toBe(1);
        if (kind === "publication") handle.dispose();
        else producer.controller.abort();
        await expect
          .poll(() => producer.readTile.mock.calls[0][2].aborted)
          .toBe(true);
        const chunkCount = async (
          state: ChunkState,
          tier = ChunkPriorityTier.VISIBLE,
        ) => {
          const statistics = (
            await registry.chunkManager.chunkQueueManager.getStatistics()
          ).get(source)!;
          return statistics[
            getChunkStateStatisticIndex(state, tier) *
              numChunkMemoryStatistics +
              ChunkMemoryStatistics.numChunks
          ];
        };
        // Existing visible demand is retried after invalidation, but the removed
        // publication must wait for cancellation rather than becoming FAILED.
        await expect.poll(() => chunkCount(ChunkState.DOWNLOADING)).toBe(1);
        late.resolve(new BigUint64Array(18).fill(999n));
        for (const tier of [
          ChunkPriorityTier.VISIBLE,
          ChunkPriorityTier.PREFETCH,
          ChunkPriorityTier.RECENT,
        ]) {
          expect(await chunkCount(ChunkState.FAILED, tier)).toBe(0);
        }
        expect(settled).toBe(false);
        expect(publish).not.toHaveBeenCalled();
        expect(source.chunks.size).toBe(0);
        expect(producer.readTile).toHaveBeenCalledTimes(1);
        expect(producer.dispose).toHaveBeenCalledTimes(1);
        const rejected = expect(pending).rejects.toMatchObject({
          name: "AbortError",
        });
        controller.abort();
        await rejected;
        await expect(getSource(registry, handle.url)).rejects.toThrow(
          "unavailable",
        );
      } finally {
        controller.abort();
        handle.dispose();
        source.dispose();
        late.resolve(new BigUint64Array(18));
      }
    },
    20000,
  );

  it("aborts offscreen real-worker demand and retries without caching FAILED or publishing late data", async () => {
    const registry = await registryFixture();
    const producer = makeLive();
    const late = Promise.withResolvers<BigUint64Array<ArrayBuffer>>();
    producer.readTile.mockImplementationOnce(() => late.promise);
    const handle = publishLiveWatershed(registry.chunkManager, producer.live);
    const dataSource = await getSource(registry, handle.url);
    const volume = dataSource.subsources[0].subsource
      .volume as WatershedMultiscaleVolumeChunkSource;
    const source = volume.getSources(sourceOptions)[0][0].chunkSource;
    const controller = new AbortController();
    try {
      const read = (signal?: AbortSignal) =>
        source.fetchChunk(
          new Float32Array(3),
          (chunk) =>
            (chunk as FrontendVolumeChunk).getValueAt(new Uint32Array(3)),
          { signal },
        );
      const pending = read(controller.signal);
      await expect.poll(() => producer.readTile.mock.calls.length).toBe(1);
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      controller.abort();
      await rejected;
      await expect
        .poll(() => producer.readTile.mock.calls[0][2].aborted)
        .toBe(true);
      expect(await read()).toBe(labelBase);
      expect(producer.readTile).toHaveBeenCalledTimes(2);
      late.resolve(new BigUint64Array(18).fill(999n));
      await Promise.resolve();
      expect(await read()).toBe(labelBase);
      expect(producer.readTile).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      handle.dispose();
      source.dispose();
      late.resolve(new BigUint64Array(18));
    }
  }, 20000);
});
