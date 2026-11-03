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
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { DataSourceRegistry } from "#src/datasource/index.js";
import { WatershedVolumeChunkSource as BackendSource } from "#src/datasource/watershed/backend.js";
import {
  WATERSHED_RESULT_MEMORY_LIMIT,
  WATERSHED_TILE_RPC_ID,
} from "#src/datasource/watershed/base.js";
import type { WatershedMultiscaleVolumeChunkSource } from "#src/datasource/watershed/frontend.js";
import { publishWatershedResult } from "#src/datasource/watershed/frontend.js";
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
import type { WatershedResult } from "#src/watershed/base.js";
import { MAX_WATERSHED_VOXELS } from "#src/watershed/base.js";
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
  const backendManager = Object.assign(new RefCounted(), {
    rpc: backendRpc,
    rpcId: managerId,
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
) {
  return Object.assign(Object.create(BackendSource.prototype), {
    chunkManager: manager,
    rpc: manager.rpc,
    parameters: { resultId },
    spec: makeVolumeChunkSpecification({
      rank: 3,
      dataType: DataType.UINT32,
      chunkDataSize: Uint32Array.from(size),
      upperVoxelBound: Float32Array.of(5, 4, 3),
      baseVoxelOffset: Float32Array.from(baseVoxelOffset),
    }),
    tempChunkDataSize: new Uint32Array(3),
    tempChunkPosition: new Float32Array(3),
  }) as BackendSource;
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
});
