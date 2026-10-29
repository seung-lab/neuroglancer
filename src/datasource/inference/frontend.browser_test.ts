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

import { describe, expect, it, vi } from "vitest";
import { ChunkManager as BackendChunkManager } from "#src/chunk_manager/backend.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { DataSourceRegistry } from "#src/datasource/index.js";
import { InferenceVolumeChunkSource as BackendSource } from "#src/datasource/inference/backend.js";
import type { InferenceResult } from "#src/datasource/inference/base.js";
import {
  CHECK_INFERENCE_RESULT_RPC_ID,
  DELETE_INFERENCE_RESULT_RPC_ID,
  INFERENCE_RESULT_MEMORY_LIMIT,
} from "#src/datasource/inference/base.js";
import {
  InferenceMultiscaleVolumeChunkSource,
  publishInferenceResult,
  publishLiveInference,
} from "#src/datasource/inference/frontend.js";
import { installInferenceDataSourceProvider } from "#src/datasource/inference/register_default.js";
import type { OnnxInferenceController } from "#src/inference/controller.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import { makeModelGeometry } from "#src/inference/model.js";
import { VolumeChunk } from "#src/sliceview/volume/backend.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeVolumeChunkSpecification,
} from "#src/sliceview/volume/base.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { RPC } from "#src/worker_rpc.js";

function makeResult(): InferenceResult {
  return {
    data: Float32Array.from({ length: 4 * 3 * 4 * 5 }, (_, i) => i),
    shapeZYX: [3, 4, 5],
    originZYX: [-7, 11, 23],
    spacingZYX: [30, 20, 10],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["nm", "nm", "nm"],
    provenance: { model: "test" },
  };
}

/** Real RPC handlers, async structured clone, and transfer/detachment semantics. */
function makeSession(waitUntilReady = false) {
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
  // No GL/queue scheduler is needed for publication or direct chunk downloads.
  const backendManager: BackendChunkManager = Object.assign(
    Object.create(BackendChunkManager.prototype),
    new RefCounted(),
    { disposed: () => {}, rpc: backendRpc, rpcId: managerId },
  );
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
  installInferenceDataSourceProvider(registry);
  return {
    frontendManager,
    backendManager,
    frontendRpc,
    backendRpc,
    registry,
    invalidateCache,
    getChunkSource,
  };
}

function backendSource(
  manager: BackendChunkManager,
  resultId: string,
  size = [5, 4, 3, 4],
) {
  return Object.assign(Object.create(BackendSource.prototype), {
    chunkManager: manager,
    rpc: manager.rpc,
    parameters: { resultId },
    spec: makeVolumeChunkSpecification({
      rank: 4,
      dataType: DataType.FLOAT32,
      chunkDataSize: Uint32Array.from(size),
      upperVoxelBound: Float32Array.of(5, 4, 3, 4),
    }),
    tempChunkDataSize: new Uint32Array(4),
    tempChunkPosition: new Float32Array(4),
  }) as BackendSource;
}

function makeChunk(source: BackendSource, grid = [0, 0, 0, 0]) {
  const chunk = new VolumeChunk();
  chunk.source = source;
  chunk.chunkGridPosition = Float32Array.from(grid);
  return chunk;
}

const signal = new AbortController().signal;

function getSource(registry: DataSourceRegistry, url: string) {
  return registry.get({
    url,
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

describe("session inference volume RPC", () => {
  it.each([1, 3, 7])(
    "round-trips a C=%i snapshot without padding through RPC, bounds and chunk copies",
    async (channels) => {
      const session = makeSession();
      const input = {
        ...makeResult(),
        channels,
        data: Float32Array.from({ length: channels * 60 }, (_, i) => i),
      };
      const handle = await publishInferenceResult(
        session.frontendManager,
        input,
      );
      const dataSource = await getSource(session.registry, handle.url);
      expect(dataSource.modelTransform.inputSpace.bounds.upperBounds[3]).toBe(
        channels,
      );
      const volume = dataSource.subsources[0].subsource
        .volume as InferenceMultiscaleVolumeChunkSource;
      volume.getSources({
        multiscaleToViewTransform: new Float32Array(12),
        displayRank: 3,
        modelChannelDimensionIndices: [3],
      });
      const spec = session.getChunkSource.mock.calls[0][1].spec;
      expect([...spec.chunkDataSize]).toEqual([5, 4, 3, channels]);
      expect([...spec.upperVoxelBound]).toEqual([5, 4, 3, channels]);
      const source = backendSource(
        session.backendManager,
        handle.url.slice(12),
      );
      source.spec = spec;
      const chunk = makeChunk(source);
      await source.download(chunk, signal);
      expect(chunk.data).toEqual(input.data);
      expect((chunk.data as Float32Array).length).toBe(60 * channels);
      handle.dispose();
    },
  );

  it.each([
    [1, false],
    [3, false],
    [1, true],
    [4, true],
  ] as const)(
    "serves a C=%i live tile with inferred physical geometry and fixed display chunks (large domain: %s)",
    async (channels, large) => {
      const session = makeSession();
      const geometry = makeModelGeometry(
        {
          inputShape: [1, 1, 16, 128, 128],
          outputShape: [1, channels, 48, 128, 128],
        },
        [45, 16, 16],
        [15, 16, 16],
      );
      const input = {
        originZYX: [3, 7, 11],
        shapeZYX: large ? [9949, 327680, 327680] : [40, 256, 256],
        spacingZYX: [45, 16, 16],
        axisNamesZYX: ["z", "y", "x"],
        unitsZYX: ["nm", "nm", "nm"],
        assertValid() {},
      } as unknown as PreparedInferenceInput;
      const run = vi.fn<OnnxInferenceController["run"]>(
        async (_input, options) => ({
          ...makeResult(),
          channels,
          data: Float32Array.from(
            { length: 16 * 60 * 60 * channels },
            (_, i) => Math.floor(i / (16 * 60 * 60)) + options.originZYX[0],
          ),
        }),
      );
      const live = new LiveInference(
        { run, cancel: vi.fn() },
        input,
        undefined,
        geometry,
      );
      const handle = await publishLiveInference(session.frontendManager, live);
      const dataSource = await getSource(session.registry, handle.url);
      expect(
        Array.from(dataSource.modelTransform.transform!.slice(20, 24)),
      ).toEqual([27, 23, 14, 0]);
      expect(Array.from(dataSource.modelTransform.inputSpace.scales)).toEqual([
        16e-9, 16e-9, 15e-9, 1,
      ]);
      expect(dataSource.modelTransform.inputSpace.bounds.upperBounds[3]).toBe(
        channels,
      );
      const volume = dataSource.subsources[0].subsource
        .volume as InferenceMultiscaleVolumeChunkSource;
      volume.getSources({
        multiscaleToViewTransform: new Float32Array(12),
        displayRank: 3,
        modelChannelDimensionIndices: [3],
      });
      const spec = session.getChunkSource.mock.calls[0][1].spec;
      expect([...spec.chunkDataSize]).toEqual([60, 60, 16, channels]);
      expect([...spec.upperVoxelBound]).toEqual([
        ...(large ? [327600, 327600, 29808] : [180, 180, 96]),
        channels,
      ]);
      expect(run).not.toHaveBeenCalled();
      if (large) {
        expect(
          live.info.shapeZYX.reduce((a, b) => a * b, channels * 4),
        ).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
        expect(live.info.byteLength).toBeLessThan(4096);
      }
      const source = backendSource(
        session.backendManager,
        handle.url.slice(12),
      );
      source.spec = spec;
      const chunk = makeChunk(source, [1, 0, 1, 0]);
      await source.download(chunk, signal);
      expect(run.mock.calls[0][1]).toMatchObject({
        geometry,
        originZYX: [30, 23, 87],
        shapeZYX: [16, 60, 60],
      });
      expect((chunk.data as Float32Array).length).toBe(16 * 60 * 60 * channels);
      for (let c = 0; c < channels; ++c)
        expect((chunk.data as Float32Array)[c * 16 * 60 * 60]).toBe(30 + c);
      handle.dispose();
    },
  );

  it("rejects a padded four-channel live buffer for a single-channel publication", async () => {
    const session = makeSession();
    const geometry = makeModelGeometry(
      { inputShape: [1, 1, 16, 128, 128], outputShape: [1, 1, 48, 128, 128] },
      [45, 16, 16],
    );
    const input = {
      originZYX: [0, 0, 0],
      shapeZYX: [40, 256, 256],
      spacingZYX: [45, 16, 16],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["nm", "nm", "nm"],
      assertValid() {},
    } as unknown as PreparedInferenceInput;
    const run = vi.fn<OnnxInferenceController["run"]>(async () => ({
      ...makeResult(),
      channels: 1,
      data: new Float32Array(16 * 60 * 60 * 4),
    }));
    const live = new LiveInference(
      { run, cancel: vi.fn() },
      input,
      undefined,
      geometry,
    );
    const handle = await publishLiveInference(session.frontendManager, live);
    const source = backendSource(session.backendManager, handle.url.slice(12));
    source.spec = makeVolumeChunkSpecification({
      rank: 4,
      dataType: DataType.FLOAT32,
      chunkDataSize: Uint32Array.of(60, 60, 16, 1),
      upperVoxelBound: Float32Array.of(180, 180, 96, 1),
    });
    await expect(source.download(makeChunk(source), signal)).rejects.toThrow(
      "Invalid live inference tile data",
    );
    handle.dispose();
  });

  it("publishes live metadata lazily and serves fixed all-channel tiles through frontend RPC", async () => {
    const session = makeSession();
    const run = vi.fn<OnnxInferenceController["run"]>(
      async (_input, options) => ({
        ...makeResult(),
        channels: 4,
        data: new Float32Array(16 * 60 * 60 * 4).map(
          (_, i) =>
            Math.floor(i / (16 * 60 * 60)) * 1000 + options.originZYX[2],
        ),
      }),
    );
    const input = {
      originZYX: [-5, 100, 200],
      shapeZYX: [40, 160, 200],
      spacingZYX: [40e-9, 16e-9, 16e-9],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["m", "m", "m"],
      assertValid() {},
    } as unknown as PreparedInferenceInput;
    const live = new LiveInference({ run, cancel: vi.fn() }, input);
    const handle = await publishLiveInference(session.frontendManager, live);
    expect(run).not.toHaveBeenCalled();
    const dataSource = await getSource(session.registry, handle.url);
    expect(
      Array.from(dataSource.modelTransform.transform!.slice(20, 24)),
    ).toEqual([210, 110, -3, 0]);
    const volume = dataSource.subsources[0].subsource
      .volume as InferenceMultiscaleVolumeChunkSource;
    volume.getSources({
      multiscaleToViewTransform: new Float32Array(12),
      displayRank: 3,
      modelChannelDimensionIndices: [3],
    });
    const spec = session.getChunkSource.mock.calls[0][1].spec;
    expect([...spec.chunkDataSize]).toEqual([60, 60, 16, 4]);
    expect([...spec.upperVoxelBound]).toEqual([180, 120, 32, 4]);
    const source = backendSource(
      session.backendManager,
      handle.url.slice("inference://".length),
    );
    source.spec = spec;
    const chunk = makeChunk(source, [1, 0, 1, 0]);
    await source.download(chunk, signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].originZYX).toEqual([13, 110, 270]);
    for (let c = 0; c < 4; ++c)
      expect((chunk.data as Float32Array)[c * 16 * 60 * 60]).toBe(
        c * 1000 + 270,
      );
    const first = chunk.data;
    const transfers: ArrayBuffer[] = [];
    const message = {};
    chunk.serialize(message, transfers);
    structuredClone(message, { transfer: transfers });
    expect((first as Float32Array).byteLength).toBe(0);
    await source.download(chunk, signal);
    expect((chunk.data as Float32Array)[0]).toBe(270);
    handle.dispose();
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "unavailable",
    );
    // The real constructor records this flag. After Stop a stale render demand
    // can arrive before view removal; it must wait for scheduler cancellation,
    // not cache a missing-result failure or assign fabricated output.
    Object.assign(source, { live: true });
    const obsolete = makeChunk(source);
    const abort = new AbortController();
    const pending = source.download(obsolete, abort.signal);
    await Promise.resolve();
    expect(obsolete.data).toBeUndefined();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await rejected;
    expect(run).toHaveBeenCalledTimes(2);
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
  });
  it("publishes a snapshot and exposes normal XYZ/c^ image sources with voxel-grid origin", async () => {
    const session = makeSession();
    const input = makeResult();
    const publication = publishInferenceResult(session.frontendManager, input);
    input.data[0] = -100;
    (input.originZYX as number[])[0] = 999;
    const handle = await publication;
    expect(handle.url).toMatch(/^inference:\/\/[a-zA-Z0-9_-]+$/);
    expect(input.data.byteLength).toBe(960);
    const dataSource = await getSource(session.registry, handle.url);
    const { modelTransform } = dataSource;
    expect(modelTransform.inputSpace.names).toEqual(["x", "y", "z", "c^"]);
    expect(modelTransform.inputSpace.units).toEqual(["m", "m", "m", ""]);
    expect(Array.from(modelTransform.inputSpace.scales)).toEqual([
      1e-8, 2e-8, 3e-8, 1,
    ]);
    expect(Array.from(modelTransform.transform!.slice(20, 24))).toEqual([
      23, 11, -7, 0,
    ]);
    const volume = dataSource.subsources[0].subsource
      .volume as InferenceMultiscaleVolumeChunkSource;
    expect(volume).toBeInstanceOf(InferenceMultiscaleVolumeChunkSource);
    expect(volume.rank).toBe(4);
    expect(volume.dataType).toBe(DataType.FLOAT32);
    volume.getSources({
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
      modelChannelDimensionIndices: [3],
    });
    const spec = session.getChunkSource.mock.calls[0][1].spec;
    expect(Array.from(spec.upperVoxelBound)).toEqual([5, 4, 3, 4]);
    expect(Array.from(spec.chunkDataSize)).toEqual([5, 4, 3, 4]);
    const source = backendSource(
      session.backendManager,
      handle.url.slice("inference://".length),
    );
    const chunk = makeChunk(source);
    await source.download(chunk, signal);
    expect((chunk.data as Float32Array)[0]).toBe(0);
    expect(chunk.data).toEqual(makeResult().data);
    handle.dispose();
    handle.dispose();
    expect(session.invalidateCache).toHaveBeenCalledTimes(1);
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "Rerun inference",
    );
    await expect(source.download(chunk, signal)).rejects.toThrow(
      "Rerun inference",
    );
  });

  it("clips actual backend edge chunks and serves fresh buffers after serialization", async () => {
    const session = makeSession();
    const handle = await publishInferenceResult(
      session.frontendManager,
      makeResult(),
    );
    const source = backendSource(
      session.backendManager,
      handle.url.slice(12),
      [3, 3, 2, 4],
    );
    const chunk = makeChunk(source, [1, 1, 1, 0]);
    await source.download(chunk, signal);
    expect(Array.from(chunk.chunkDataSize!)).toEqual([2, 1, 1, 4]);
    expect(chunk.data).toEqual(
      Float32Array.of(58, 59, 118, 119, 178, 179, 238, 239),
    );
    const message: Record<string, unknown> = {};
    const transfers: Transferable[] = [];
    chunk.serialize(message, transfers);
    const delivered = structuredClone(message, { transfer: transfers });
    (delivered.data as Float32Array)[0] = -1;
    await source.download(chunk, signal);
    expect((chunk.data as Float32Array)[0]).toBe(58);
    handle.dispose();
  });

  it("snapshots before worker startup, and manager teardown removes backend results", async () => {
    const session = makeSession(true);
    const input = makeResult();
    const pending = publishInferenceResult(session.frontendManager, input);
    input.data.fill(-1);
    session.frontendRpc.onPeerReady();
    const handle = await pending;
    const source = backendSource(session.backendManager, handle.url.slice(12));
    const chunk = makeChunk(source);
    await source.download(chunk, signal);
    expect((chunk.data as Float32Array)[0]).toBe(0);
    session.frontendManager.dispose();
    await Promise.resolve();
    await expect(source.download(chunk, signal)).rejects.toThrow(
      "Rerun inference",
    );
    handle.dispose();
  });

  it("fails publication if the session is disposed while the worker is starting", async () => {
    const session = makeSession(true);
    const pending = publishInferenceResult(
      session.frontendManager,
      makeResult(),
    );
    session.frontendManager.dispose();
    session.frontendRpc.onPeerReady();
    await expect(pending).rejects.toThrow("Rerun inference");
  });

  it("rejects missing results, cross-viewer/reload URLs and lost worker storage", async () => {
    const session = makeSession();
    await expect(
      getSource(session.registry, "inference://absent"),
    ).rejects.toThrow("Rerun inference");
    const handle = await publishInferenceResult(
      session.frontendManager,
      makeResult(),
    );
    const other = makeSession();
    await expect(getSource(other.registry, handle.url)).rejects.toThrow(
      "Rerun inference",
    );
    session.frontendRpc.invoke(DELETE_INFERENCE_RESULT_RPC_ID, {
      chunkManager: 100,
      resultId: handle.url.slice(12),
    });
    await expect(getSource(session.registry, handle.url)).rejects.toThrow(
      "Rerun inference",
    );
    await expect(
      session.frontendRpc.promiseInvoke(CHECK_INFERENCE_RESULT_RPC_ID, {
        chunkManager: 100,
        resultId: "absent",
      }),
    ).rejects.toThrow("Rerun inference");
    handle.dispose();
  });

  it("rejects the budget before copying a tensor (metadata counts too)", async () => {
    const session = makeSession();
    const data = new Float32Array(INFERENCE_RESULT_MEMORY_LIMIT / 4);
    const from = vi.spyOn(Float32Array, "from");
    try {
      await expect(
        publishInferenceResult(session.frontendManager, {
          ...makeResult(),
          data,
          shapeZYX: [1, 2048, 16384],
        }),
      ).rejects.toThrow("512 MiB session memory limit");
      expect(from).toHaveBeenCalledTimes(1); // makeResult only, no publication copy
    } finally {
      from.mockRestore();
    }
  });
});
