import { describe, expect, it, vi } from "vitest";
import { ChunkManager as BackendChunkManager } from "#src/chunk_manager/backend.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { DataSource } from "#src/datasource/index.js";
import { DataSourceRegistry } from "#src/datasource/index.js";
import { InferenceVolumeChunkSource as BackendSource } from "#src/datasource/inference/backend.js";
import type { InferenceMultiscaleVolumeChunkSource } from "#src/datasource/inference/frontend.js";
import { publishInferenceResult } from "#src/datasource/inference/frontend.js";
import { installInferenceDataSourceProvider } from "#src/datasource/inference/register_default.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import { getRenderLayerTransform } from "#src/render_coordinate_transform.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import { VolumeChunk as BackendChunk } from "#src/sliceview/volume/backend.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/frontend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { valueOrThrow } from "#src/util/error.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import { prepareAffinityInput } from "#src/watershed/input.js";
import { RPC } from "#src/worker_rpc.js";

const signal = new AbortController().signal;

/** Real publication RPC and backend downloads, without a rendering/GL scheduler. */
function session() {
  type Target = ConstructorParameters<typeof RPC>[0];
  const targets: Target[] = [
    { onmessage: null, postMessage() {} },
    { onmessage: null, postMessage() {} },
  ];
  targets.forEach((from, i) => {
    from.postMessage = (data, transfers) => {
      const copy = structuredClone(data, { transfer: transfers ?? [] });
      queueMicrotask(() =>
        targets[1 - i].onmessage!({ data: copy } as MessageEvent),
      );
    };
  });
  const frontendRpc = new RPC(targets[0], false);
  const backendRpc = new RPC(targets[1], false);
  const managerId = 100;
  const backendManager = Object.assign(
    Object.create(BackendChunkManager.prototype),
    new RefCounted(),
    {
      rpc: backendRpc,
      rpcId: managerId,
      disposed() {},
    },
  ) as BackendChunkManager;
  backendRpc.set(managerId, backendManager);
  let source: VolumeChunkSource | undefined;
  const fetches: string[] = [];
  const invalidateCache = vi.fn();
  const getChunkSource = (
    _ctor: unknown,
    options: {
      spec: VolumeChunkSpecification;
      parameters: { resultId: string };
    },
  ) => {
    if (source === undefined) {
      const backend = Object.assign(Object.create(BackendSource.prototype), {
        chunkManager: backendManager,
        rpc: backendRpc,
        parameters: options.parameters,
        spec: options.spec,
        tempChunkDataSize: new Uint32Array(4),
        tempChunkPosition: new Float32Array(4),
      }) as BackendSource;
      source = Object.assign(
        Object.create(VolumeChunkSource.prototype),
        new RefCounted(),
        {
          spec: options.spec,
          chunks: new Map(),
          invalidateCache,
          disposed() {},
          // Populate the actual CPU chunk cache from the actual inference backend.
          // The real fetchChunk implementation then invokes the reader callback.
          async fetchChunk<T>(
            grid: Float32Array,
            copy: (chunk: VolumeChunk) => T,
            progress: Partial<ProgressOptions>,
          ) {
            fetches.push(grid.join());
            if (!source!.chunks.has(grid.join())) {
              const chunk = new BackendChunk();
              chunk.source = backend;
              chunk.chunkGridPosition = grid;
              await backend.download(chunk, progress.signal!);
              source!.chunks.set(
                grid.join(),
                new UncompressedVolumeChunk(source!, {
                  chunkGridPosition: grid,
                  chunkDataSize: chunk.chunkDataSize,
                  data: chunk.data,
                }),
              );
            }
            return VolumeChunkSource.prototype.fetchChunk.call(
              source!,
              grid,
              copy,
              progress,
            ) as Promise<T>;
          },
        },
      ) as VolumeChunkSource;
    }
    return source.addRef();
  };
  const manager = Object.assign(new RefCounted(), {
    rpc: frontendRpc,
    rpcId: managerId,
    getChunkSource,
  }) as unknown as ChunkManager;
  frontendRpc.set(managerId, manager);
  const registry = new DataSourceRegistry({
    chunkManager: manager,
    kvStoreContext: { baseKvStoreProviders: new Map() },
  } as unknown as ConstructorParameters<typeof DataSourceRegistry>[0]);
  installInferenceDataSourceProvider(registry);
  return { manager, registry, source: () => source!, fetches, invalidateCache };
}

/** Minimal live ImageUserLayer state; real native/output scale normalization. */
function layerFor(dataSource: DataSource) {
  const { modelTransform } = dataSource;
  const native = modelTransform.outputSpace;
  const transform = new WatchableCoordinateSpaceTransform(modelTransform);
  const global = new WatchableValue(
    makeCoordinateSpace({
      names: native.names.slice(0, 3),
      units: native.units.slice(0, 3),
      scales: native.scales.slice(0, 3).map((s) => s * 4),
    }),
  );
  const local = new WatchableValue(emptyValidCoordinateSpace);
  const channel = new WatchableValue(
    makeCoordinateSpace({
      names: ["c^"],
      units: [""],
      scales: Float64Array.of(1),
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({
          lowerBounds: Float64Array.of(0),
          upperBounds: Float64Array.of(4),
        }),
      ],
    }),
  );
  transform.outputSpace.value = makeCoordinateSpace({
    names: native.names,
    units: native.units,
    scales: Float64Array.of(...global.value.scales, 1),
  });
  const volume = dataSource.subsources[0].subsource
    .volume as InferenceMultiscaleVolumeChunkSource;
  const subsource = {
    enabled: true,
    activated: {},
    subsourceEntry: dataSource.subsources[0],
    modelSubspaceDimensionIndices: [0, 1, 2, 3],
    subsourceToModelSubspaceTransform: matrix.createIdentity(Float32Array, 5),
  };
  const renderLayer = Object.assign(
    Object.create(SliceViewVolumeRenderLayer.prototype),
    {
      multiscaleSource: volume,
      wasDisposed: false,
      transform: new WatchableValue(
        valueOrThrow(
          getRenderLayerTransform(
            global.value,
            local.value,
            transform.value,
            subsource,
            channel.value,
          ),
        ),
      ),
    },
  );
  return {
    type: "image",
    isReady: true,
    wasDisposed: false,
    renderLayers: [renderLayer],
    dataSources: [
      { loadState: { dataSource, transform, subsources: [subsource] } },
    ],
    dataSourcesChanged: new NullarySignal(),
    layersChanged: new NullarySignal(),
    readyStateChanged: new NullarySignal(),
    channelCoordinateSpace: channel,
    managedLayer: {
      localCoordinateSpace: local,
      manager: { root: { coordinateSpace: global } },
    },
  } as unknown as ImageUserLayer;
}

async function publishedFixture() {
  const s = session();
  const shapeZYX = [3, 4, 35];
  const data = Float32Array.from(
    { length: 4 * 3 * 4 * 35 },
    (_, i) => i / 2000,
  );
  const handle = await publishInferenceResult(s.manager, {
    data,
    channels: 4,
    shapeZYX,
    originZYX: [-7, 11, 23],
    spacingZYX: [30, 20, 10],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["nm", "nm", "nm"],
    provenance: {},
  });
  const dataSource = await s.registry.get({
    url: handle.url,
    transform: undefined,
    globalCoordinateSpace: new WatchableValue(emptyValidCoordinateSpace),
  });
  const layer = layerFor(dataSource);
  return { s, handle, layer, data };
}

describe("affinity input with an inference:// volume", () => {
  it("reads real native chunks across the 32-voxel boundary and preserves global output translation", async () => {
    const { s, handle, layer, data } = await publishedFixture();
    const input = prepareAffinityInput(layer);
    try {
      expect(input.lowerBoundXYZ).toEqual([0, 0, 0]);
      expect(input.upperBoundXYZ).toEqual([35, 4, 3]);
      expect(input.channelCount).toBe(4);
      expect(input.originXYZ).toEqual([23, 11, -7]);
      expect(input.spacingXYZ).toEqual([10e-9, 20e-9, 30e-9]);
      expect(input.unitsXYZ).toEqual(["m", "m", "m"]);
      const actual = await input.readRegion(
        [30, 1, 1],
        [5, 3, 2],
        [3, 1, 0],
        signal,
      );
      const expected: number[] = [];
      for (const c of [3, 1, 0])
        for (let z = 1; z < 3; ++z)
          for (let y = 1; y < 4; ++y)
            for (let x = 30; x < 35; ++x)
              expected.push(data[((c * 3 + z) * 4 + y) * 35 + x]);
      expect(actual).toEqual(Float32Array.from(expected));
      expect(s.fetches).toEqual(["0,0,0,0", "1,0,0,0"]);
      expect(s.source().refCount).toBe(2);
      const loadState = layer.dataSources[0].loadState!;
      if (loadState.error !== undefined) throw loadState.error;
      expect(loadState.transform.value.transform[20]).toBe(23 / 4);
    } finally {
      input.dispose();
      handle.dispose();
    }
    expect(s.source().refCount).toBe(1);
  });

  it("rejects a deleted publication despite cached accessor chunks and aborts its lifetime", async () => {
    const { s, handle, layer } = await publishedFixture();
    const input = prepareAffinityInput(layer);
    await input.readRegion([0, 0, 0], [1, 1, 1], [0, 1, 2], signal);
    handle.dispose();
    expect(s.invalidateCache).toHaveBeenCalledOnce();
    expect(input.isValid()).toBe(false);
    expect(input.signal.aborted).toBe(true);
    await expect(
      input.readRegion([0, 0, 0], [1, 1, 1], [0, 1, 2], signal),
    ).rejects.toThrow("disposed or stale");
    expect(s.fetches).toHaveLength(1);
    input.dispose();
    input.dispose();
    expect(s.source().refCount).toBe(1);
  });
});
